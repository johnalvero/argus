import { NextRequest, NextResponse } from "next/server";

/**
 * Shared request hardening helpers.
 *
 * Two narrow concerns live here, deliberately decoupled from auth so the
 * ingest endpoint (bearer-token) and admin endpoints (cookie) can both
 * use them:
 *
 *   1. `checkContentLength` — reject oversized POST/PUT/PATCH bodies
 *      BEFORE we buffer them. Without this Node will happily load a
 *      hostile 500 MB JSON into memory before our parser balks.
 *
 *   2. `checkOrigin` — cheap CSRF defense for cookie-authed mutations.
 *      Same-origin (or no-Origin/Referer at all, e.g. curl) passes;
 *      cross-origin browser requests fail. This is intentionally lax
 *      on missing headers — programmatic clients commonly omit them
 *      and a real CSRF attack from a browser always sets Origin.
 *
 * Both return `null` on success or a `NextResponse` to short-circuit
 * with — the calling pattern mirrors `requireAuth`.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface SizeCheckOptions {
  /** Max body in bytes. */
  max: number;
  /** Optional label for the error payload (defaults to "payload"). */
  label?: string;
}

/**
 * Pre-flight body size cap. Reads only the `Content-Length` header — no
 * body consumption — and rejects with 413 if it exceeds `max`.
 *
 * Notes:
 *  - Requests without Content-Length (chunked, some proxies) pass this
 *    check; the route handler should still guard the parsed body with a
 *    soft cap. For Argus this is acceptable because all real clients
 *    (browser fetch, our agent) emit Content-Length.
 *  - We treat malformed Content-Length as "unknown" rather than 400 —
 *    keeps the guard charitable, route can still reject post-parse.
 */
export function checkContentLength(
  req: NextRequest,
  opts: SizeCheckOptions
): NextResponse | null {
  const header = req.headers.get("content-length");
  if (!header) return null;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > opts.max) {
    const label = opts.label ?? "payload";
    const limitMb = Math.round(opts.max / (1024 * 1024));
    return NextResponse.json(
      { error: `${label} too large (max ${limitMb} MB)` },
      { status: 413 }
    );
  }
  return null;
}

/**
 * Origin/Referer same-host check for mutating cookie-authed routes.
 *
 * Logic:
 *  - GET/HEAD/OPTIONS: pass.
 *  - No Origin AND no Referer header: pass (non-browser client; CSRF
 *    requires a browser to ride the cookie).
 *  - Origin/Referer present: must match the request's own host.
 *
 * The "host" comparison uses `req.nextUrl.host` — that's what Next.js
 * resolves after trust-proxy / X-Forwarded-Host handling, so we don't
 * have to reproduce that logic here.
 */
export function checkOrigin(req: NextRequest): NextResponse | null {
  const method = req.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) return null;

  const expectedHost = req.nextUrl.host;
  if (!expectedHost) return null;

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (!origin && !referer) return null; // non-browser client, no cookie risk

  const candidates: string[] = [];
  if (origin) candidates.push(origin);
  if (referer) candidates.push(referer);

  for (const c of candidates) {
    try {
      const u = new URL(c);
      if (u.host === expectedHost) return null;
    } catch {
      // Malformed header — treat as failure below.
    }
  }

  return NextResponse.json(
    { error: "cross-origin request blocked" },
    { status: 403 }
  );
}
