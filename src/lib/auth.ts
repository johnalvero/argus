import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkContentLength, checkOrigin } from "@/lib/requestGuards";

/**
 * Auth primitives for Argus.
 *
 * UI auth: JWT in an HttpOnly cookie. Tokens are HS256-pinned on verify
 * (defends against `alg: none` confusion). bcrypt cost factor 12 from
 * the start — no 10→12 retrofit later.
 *
 * The `verifyAuth` hot path keeps a 30s per-process cache keyed by
 * userId so we don't hammer SQLite for every authenticated request. The
 * cache sources `isAdmin` and `mustChangePassword` from the live row,
 * so role/password-flag changes propagate within at most 30s — and
 * write-paths call `invalidateUserAuthCache(userId)` to drop entries
 * immediately when they mutate auth state.
 *
 * `mustChangePassword` is enforced server-side here, not just in the
 * UI: a logged-in user with the flag set can hit no API except the
 * narrow set the password-change flow itself depends on. This is
 * deliberate — `statusupdates` only client-gated. We do better.
 *
 * Agent (ingest) auth is a separate bearer-token scheme — see
 * `verifyIngestToken` below.
 */

export const SESSION_COOKIE_NAME = "argus_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
const BCRYPT_ROUNDS = 12;

function loadJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Generate a strong value and put it in .env " +
        "(e.g. `node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"`)."
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `JWT_SECRET is too short (${secret.length} bytes). Require >= 32 bytes.`
    );
  }
  return secret;
}

const JWT_SECRET: string = loadJwtSecret();

// Loud production-config warnings. Surface dangerous flag combos at
// process start so an operator notices in their boot logs rather than
// after a security incident. These do NOT abort startup — there are
// legitimate prod-like environments (CI smoke tests, blue-green warmup
// behind plaintext) where the override is intentional.
(function warnUnsafeProdConfig() {
  if (process.env.NODE_ENV !== "production") return;
  // Skip during `next build` — only warn at runtime. NEXT_PHASE is set
  // to "phase-production-build" while the build is executing route
  // modules; operators should see the warning on first boot, not in
  // their CI logs.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.INSECURE_COOKIES === "1") {
    console.warn(
      "[security] WARN NODE_ENV=production with INSECURE_COOKIES=1 — " +
        "session cookies will be sent over plain HTTP. Disable in real " +
        "deployments."
    );
  }
  if (process.env.TRUST_PROXY !== "true") {
    console.warn(
      "[security] WARN NODE_ENV=production with TRUST_PROXY!=\"true\" — " +
        "client IPs in rate-limit buckets and audit logs will be the " +
        "socket peer (your reverse proxy), not the real client. Set " +
        "TRUST_PROXY=true once a trusted proxy strips inbound XFF."
    );
  }
})();

// ─── Types ───────────────────────────────────────────────────────────────
export interface JwtPayload {
  userId: number;
  email: string;
  isAdmin: boolean;
  tokenVersion: number;
  /**
   * Mirror of `User.mustChangePassword` at issue time. The Edge-runtime
   * middleware uses it for UX routing without a DB lookup. The
   * authoritative value still comes from the live row inside
   * `getSession`/`verifyAuth`, which overrides on every request.
   */
  mustChangePassword: boolean;
}

export type AuthedUser = JwtPayload;

// ─── Passwords ───────────────────────────────────────────────────────────
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

// ─── Tokens ──────────────────────────────────────────────────────────────
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: SESSION_MAX_AGE_SECONDS,
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    // Pin algorithm to defend against `alg: none` / RS/HS confusion.
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload & Partial<JwtPayload>;
    if (
      typeof decoded.userId !== "number" ||
      typeof decoded.email !== "string" ||
      typeof decoded.isAdmin !== "boolean" ||
      typeof decoded.tokenVersion !== "number" ||
      typeof decoded.mustChangePassword !== "boolean"
    ) {
      return null;
    }
    return {
      userId: decoded.userId,
      email: decoded.email,
      isAdmin: decoded.isAdmin,
      tokenVersion: decoded.tokenVersion,
      mustChangePassword: decoded.mustChangePassword,
    };
  } catch {
    return null;
  }
}

// ─── Per-process auth cache ──────────────────────────────────────────────
/**
 * 30-second cache for the post-JWT DB lookup. SQLite is single-writer
 * and we don't want to serialise read traffic behind every authenticated
 * request. Write-paths drop entries via `invalidateUserAuthCache` so
 * revocation/role changes take effect instantly — not after the TTL.
 */
interface AuthCacheEntry {
  payload: AuthedUser;
  expiresAt: number;
}
const authCache = new Map<number, AuthCacheEntry>();
const AUTH_CACHE_TTL_MS = 30_000;
const AUTH_CACHE_SWEEP_THRESHOLD = 1000;

export function invalidateUserAuthCache(userId: number): void {
  authCache.delete(userId);
}

function maybeSweepAuthCache(): void {
  if (authCache.size < AUTH_CACHE_SWEEP_THRESHOLD) return;
  const now = Date.now();
  for (const [id, entry] of authCache) {
    if (entry.expiresAt <= now) authCache.delete(id);
  }
}

// ─── Session resolution ──────────────────────────────────────────────────
function readCookie(req: NextRequest): string | null {
  return req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

/**
 * Resolve the cookie to a fresh `AuthedUser`. Sources `isAdmin` and
 * `mustChangePassword` from the DB so changes propagate within at most
 * the cache TTL (30s) — or instantly when the write-path invalidates.
 */
export async function getSession(
  req: NextRequest
): Promise<AuthedUser | null> {
  const token = readCookie(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;

  // Hot path: cache hit short-circuits the DB lookup.
  const cached = authCache.get(payload.userId);
  if (cached && cached.expiresAt > Date.now()) {
    // Still cross-check tokenVersion against the cached snapshot — a
    // stale cookie from before a password change is rejected.
    if (cached.payload.tokenVersion !== payload.tokenVersion) return null;
    return cached.payload;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        isAdmin: true,
        mustChangePassword: true,
        tokenVersion: true,
      },
    });
    if (!user) {
      authCache.delete(payload.userId);
      return null;
    }
    if (user.tokenVersion !== payload.tokenVersion) {
      // Evict so the next attempt re-checks the DB rather than serving
      // stale cached state.
      authCache.delete(payload.userId);
      return null;
    }
    const fresh: AuthedUser = {
      userId: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      tokenVersion: user.tokenVersion,
      mustChangePassword: user.mustChangePassword,
    };
    authCache.set(payload.userId, {
      payload: fresh,
      expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    });
    maybeSweepAuthCache();
    return fresh;
  } catch (err) {
    // Fail closed on DB hiccups. Don't log the raw error — Prisma
    // exceptions can carry the failing SQL.
    console.error(
      "getSession: db lookup failed",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ─── Guards ──────────────────────────────────────────────────────────────
export interface RequireAuthOptions {
  /**
   * Skip the `mustChangePassword` gate. Use ONLY on endpoints the
   * forced-rotation flow itself depends on (change-password, me,
   * logout).
   */
  allowMustChangePassword?: boolean;
  /**
   * Body-size cap (bytes) checked against the request's `Content-Length`
   * header BEFORE the handler buffers the body. Defaults to 1 MB for
   * mutating methods. Set higher for endpoints that legitimately accept
   * larger payloads (e.g. logo upload). Set to `Infinity` to skip.
   */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function maybeCheckBodySize(
  req: NextRequest,
  opts: RequireAuthOptions
): NextResponse | null {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return null;
  const max = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isFinite(max)) return null;
  return checkContentLength(req, { max });
}

function mustChangePasswordResponse(): NextResponse {
  return NextResponse.json(
    { error: "must_change_password" },
    { status: 403 }
  );
}

export async function requireAuth(
  req: NextRequest,
  opts: RequireAuthOptions = {}
): Promise<AuthedUser | NextResponse> {
  // Same Origin/Referer + size guards as requireAdmin — covers the
  // non-admin mutating routes (notifications read, display-prefs, etc.)
  // so the CSRF surface is closed regardless of which guard a route
  // happens to use.
  const originGuard = checkOrigin(req);
  if (originGuard) return originGuard;
  const sizeGuard = maybeCheckBodySize(req, opts);
  if (sizeGuard) return sizeGuard;

  const user = await getSession(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (user.mustChangePassword && !opts.allowMustChangePassword) {
    return mustChangePasswordResponse();
  }
  return user;
}

export async function requireAdmin(
  req: NextRequest,
  opts: RequireAuthOptions = {}
): Promise<AuthedUser | NextResponse> {
  // CSRF defense for cookie-authed mutating routes. Runs before the DB
  // lookup so a hostile cross-origin POST is rejected with no side
  // effects (no audit row, no cache fill).
  const originGuard = checkOrigin(req);
  if (originGuard) return originGuard;

  // Body-size pre-check on mutating methods — rejects an oversized
  // request without buffering the body.
  const sizeGuard = maybeCheckBodySize(req, opts);
  if (sizeGuard) return sizeGuard;

  const user = await getSession(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!user.isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (user.mustChangePassword && !opts.allowMustChangePassword) {
    return mustChangePasswordResponse();
  }
  return user;
}

// ─── Login rate limiter ──────────────────────────────────────────────────
const RL_WINDOW_MS = 60_000;
const RL_MAX = 10;
const loginBuckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function checkLoginRateLimit(ip: string): RateLimitResult {
  const now = Date.now();
  const bucket = loginBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    const fresh = { count: 1, resetAt: now + RL_WINDOW_MS };
    loginBuckets.set(ip, fresh);
    return { allowed: true, remaining: RL_MAX - 1, resetAt: fresh.resetAt };
  }
  if (bucket.count >= RL_MAX) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }
  bucket.count += 1;
  return {
    allowed: true,
    remaining: RL_MAX - bucket.count,
    resetAt: bucket.resetAt,
  };
}

/**
 * Best-effort client IP. Ignore XFF unless we explicitly trust a
 * reverse proxy — otherwise a remote client could spoof the bucket
 * key and bypass rate-limiting trivially.
 */
export function extractClientIp(req: NextRequest): string {
  const trustProxy = process.env.TRUST_PROXY === "true";
  if (trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  const ip = (req as unknown as { ip?: string }).ip;
  if (ip) return ip;
  return "unknown";
}

// ─── Cookies ─────────────────────────────────────────────────────────────
export interface CookieSpec {
  name: string;
  value: string;
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

function cookieSecure(): boolean {
  if (process.env.INSECURE_COOKIES === "1") return false;
  return process.env.NODE_ENV === "production";
}

export function buildSessionCookie(token: string): CookieSpec {
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function buildClearSessionCookie(): CookieSpec {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: 0,
  };
}
