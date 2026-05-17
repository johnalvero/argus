import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import {
  BOOL_FIELDS,
  INT_FIELDS,
  NULLABLE_INT_FIELDS,
  applyConfigUpdate,
  getCollectorConfig,
  toAdminShape,
} from "@/lib/collectorConfig";
import type {
  CollectorConfigBools,
  CollectorConfigInts,
  CollectorConfigNullableInts,
} from "@/lib/types";

/**
 * GET /api/admin/collector-config — read the singleton row.
 * PUT  — partial update. Body accepts any subset of:
 *          • the `collect*` boolean fields (agent toggles)
 *          • the `staleHost{Amber,Red}Days` + `reportRetentionDays`
 *            positive-integer fields
 *          • the `inactiveHostRetentionDays` nullable-integer field
 *            (null = disable host expiry, preserving today's behavior)
 *        Unrecognised keys are rejected, missing fields are left at
 *        their current DB value. Bumps `version` iff at least one
 *        field actually changes.
 *
 * Auth: admin JWT (cookie). Force-rotate gate still applies.
 */
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const row = await getCollectorConfig();
  return NextResponse.json(toAdminShape(row));
}

const ALLOWED_BOOLS = new Set<string>(BOOL_FIELDS);
const ALLOWED_INTS = new Set<string>(INT_FIELDS);
const ALLOWED_NULLABLE_INTS = new Set<string>(NULLABLE_INT_FIELDS);

export async function PUT(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "body must be an object" },
      { status: 400 }
    );
  }

  // Whitelist + per-type validation. Keeps a typo (or an attacker)
  // from accidentally setting `version`, `updatedAt`, or `lastCleanupAt`
  // directly.
  const bools: Partial<CollectorConfigBools> = {};
  const ints: Partial<CollectorConfigInts> = {};
  const nullableInts: Partial<CollectorConfigNullableInts> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_BOOLS.has(key)) {
      if (typeof value !== "boolean") {
        return NextResponse.json(
          { error: `${key} must be a boolean` },
          { status: 400 }
        );
      }
      bools[key as keyof CollectorConfigBools] = value;
      continue;
    }
    if (ALLOWED_INTS.has(key)) {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1
      ) {
        return NextResponse.json(
          { error: `${key} must be a positive integer` },
          { status: 400 }
        );
      }
      ints[key as keyof CollectorConfigInts] = value;
      continue;
    }
    if (ALLOWED_NULLABLE_INTS.has(key)) {
      if (value === null) {
        nullableInts[key as keyof CollectorConfigNullableInts] = null;
        continue;
      }
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1
      ) {
        return NextResponse.json(
          { error: `${key} must be a positive integer or null` },
          { status: 400 }
        );
      }
      nullableInts[key as keyof CollectorConfigNullableInts] = value;
      continue;
    }
    return NextResponse.json(
      { error: `unknown field: ${key}` },
      { status: 400 }
    );
  }

  // Cross-field constraints. Resolve against current row so a partial
  // PUT (e.g. only amber) is still validated end-to-end.
  if (
    Object.keys(ints).length > 0 ||
    Object.keys(nullableInts).length > 0
  ) {
    const current = await getCollectorConfig();
    const nextAmber = ints.staleHostAmberDays ?? current.staleHostAmberDays;
    const nextRed = ints.staleHostRedDays ?? current.staleHostRedDays;
    if (nextRed <= nextAmber) {
      return NextResponse.json(
        {
          error:
            "staleHostRedDays must be greater than staleHostAmberDays",
        },
        { status: 400 }
      );
    }
    const nextReportRetention =
      ints.reportRetentionDays ?? current.reportRetentionDays;
    // Resolve `inactiveHostRetentionDays` carefully — `null` is a
    // valid explicit clear. `undefined` means "leave as-is."
    const nextInactiveHost =
      "inactiveHostRetentionDays" in nullableInts
        ? nullableInts.inactiveHostRetentionDays
        : current.inactiveHostRetentionDays;
    if (
      nextInactiveHost != null &&
      nextInactiveHost < nextReportRetention
    ) {
      return NextResponse.json(
        {
          error:
            "inactiveHostRetentionDays must be >= reportRetentionDays " +
            "(host expiry should not outrun report expiry)",
        },
        { status: 400 }
      );
    }
  }

  // Snapshot BEFORE so the audit row can summarise which fields changed.
  // Skipped on the no-op fast path (changed === false) so we don't spam
  // the ledger with empty rows.
  const before = await getCollectorConfig();
  const { row, changed } = await applyConfigUpdate({
    ...bools,
    ...ints,
    ...nullableInts,
  });

  if (changed) {
    const allKeys = [
      ...BOOL_FIELDS,
      ...INT_FIELDS,
      ...NULLABLE_INT_FIELDS,
    ] as const;
    const diffBefore: Record<string, unknown> = {};
    const diffAfter: Record<string, unknown> = {};
    const parts: string[] = [];
    for (const key of allKeys) {
      const b = (before as unknown as Record<string, unknown>)[key];
      const a = (row as unknown as Record<string, unknown>)[key];
      if (b !== a) {
        diffBefore[key] = b;
        diffAfter[key] = a;
        parts.push(`${key} ${String(b)} → ${String(a)}`);
      }
    }
    parts.push(`version ${before.version} → ${row.version}`);
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "update",
      entityType: "collector_config",
      entityId: "default",
      summary: `collector config: ${parts.join(", ")}`,
      diff: { before: diffBefore, after: diffAfter },
    });
  }

  return NextResponse.json(toAdminShape(row));
}
