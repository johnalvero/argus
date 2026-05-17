import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Append-only audit ledger.
 *
 * Called from admin POST/PUT/PATCH/DELETE routes AFTER the mutation
 * succeeds. The write is fire-and-forget — a failed audit insert MUST
 * NOT break the actual admin action, so we swallow the error and log to
 * the server console.
 *
 * IP resolution mirrors the request-context conventions used elsewhere:
 *   1. `x-forwarded-for` first hop (when behind a reverse proxy)
 *   2. `x-real-ip`
 *   3. null (we don't trust the socket address on its own)
 *
 * User agent is truncated to 200 chars — long enough to recognise the
 * client, short enough to keep the row small.
 */

export interface AuditLogParams {
  actorId: number | null;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  diff?: { before: unknown; after: unknown };
}

function extractIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return null;
}

function extractUserAgent(req: NextRequest): string | null {
  const ua = req.headers.get("user-agent");
  if (!ua) return null;
  return ua.slice(0, 200);
}

/**
 * Keys whose values must NEVER hit the audit ledger. Match is case-
 * insensitive on either an exact key or a substring (so `secretAccessKey`
 * is caught by `secret`, `passwordHash` by `password`, etc.).
 *
 * Why: an admin updating SES credentials would otherwise persist the
 * raw secretAccessKey into AuditEvent.diff in the clear, making the
 * audit table a juicier target than the encrypted ses column.
 */
const REDACT_KEY_NEEDLES = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "cookie",
  "authorization",
  "ciphertext",
  "passwordhash",
];
const REDACTED = "[redacted]";

function shouldRedactKey(key: string): boolean {
  const k = key.toLowerCase();
  for (const needle of REDACT_KEY_NEEDLES) {
    if (k.includes(needle)) return true;
  }
  return false;
}

/**
 * Deep-clone with redaction. Walks objects/arrays; primitives pass
 * through unchanged. Cycles aren't expected here (we only serialise
 * shallow audit diffs) but we still guard with a WeakSet to be safe.
 */
function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[cycle]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = shouldRedactKey(k) ? REDACTED : redact(v, seen);
  }
  return out;
}

/**
 * Persist one audit event. Returns immediately — the caller never
 * awaits the DB write so a slow insert doesn't add latency to the
 * admin response.
 */
export function auditLog(
  req: NextRequest,
  params: AuditLogParams
): void {
  const ip = extractIp(req);
  const userAgent = extractUserAgent(req);
  const diff = params.diff
    ? JSON.stringify({
        before: redact(params.diff.before),
        after: redact(params.diff.after),
      })
    : null;

  prisma.auditEvent
    .create({
      data: {
        actorId: params.actorId,
        actorEmail: params.actorEmail,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        summary: params.summary,
        diff,
        ip,
        userAgent,
      },
    })
    .catch((err) => {
      // Fire-and-forget — never let an audit failure bubble up.
      console.error(
        "auditLog: insert failed",
        err instanceof Error ? err.message : String(err)
      );
    });
}
