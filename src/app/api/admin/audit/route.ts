import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import type { AuditEventRow, AuditListResponse } from "@/lib/types";

/**
 * GET /api/admin/audit — cursor-paginated audit log.
 *
 * Query:
 *   - limit       1..200 (default 50)
 *   - before      cursor id; rows with id < before are returned
 *   - actorId     filter by actor user id (NULL actor rows excluded)
 *   - entityType  exact match on the entity-type discriminator
 *   - action      exact match on the action verb
 *
 * Response:
 *   { events: AuditEventRow[], hasMore: boolean, nextBefore?: number }
 *
 * Auth: admin JWT (cookie). Force-rotate gate still applies.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parsePositiveInt(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const url = req.nextUrl;
  const limitRaw = parsePositiveInt(url.searchParams.get("limit"));
  const limit = Math.min(limitRaw ?? DEFAULT_LIMIT, MAX_LIMIT);
  const before = parsePositiveInt(url.searchParams.get("before"));
  const actorId = parsePositiveInt(url.searchParams.get("actorId"));
  const entityType = url.searchParams.get("entityType")?.trim() || null;
  const action = url.searchParams.get("action")?.trim() || null;

  const where: Prisma.AuditEventWhereInput = {};
  if (before != null) where.id = { lt: before };
  if (actorId != null) where.actorId = actorId;
  if (entityType) where.entityType = entityType;
  if (action) where.action = action;

  // Fetch one extra row to know if there's another page — cheaper than
  // a follow-up COUNT(*) and exact for cursor pagination.
  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: { id: "desc" },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;

  const events: AuditEventRow[] = trimmed.map((r) => {
    let diff: AuditEventRow["diff"] = null;
    if (r.diff) {
      try {
        const parsed = JSON.parse(r.diff) as {
          before?: unknown;
          after?: unknown;
        };
        diff = { before: parsed.before, after: parsed.after };
      } catch {
        // If the row was somehow written with a non-JSON diff string,
        // surface the raw text so the operator still has *something*.
        diff = { before: null, after: r.diff };
      }
    }
    return {
      id: r.id,
      actorEmail: r.actorEmail,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      summary: r.summary,
      diff,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
    };
  });

  const body: AuditListResponse = {
    events,
    hasMore,
    ...(hasMore && trimmed.length > 0
      ? { nextBefore: trimmed[trimmed.length - 1]!.id }
      : {}),
  };
  return NextResponse.json(body);
}
