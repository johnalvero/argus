import { NextRequest, NextResponse } from "next/server";

/**
 * Lightweight cookie-presence gate so unauthenticated browsers never
 * see protected chrome. Real authorisation runs server-side in
 * `requireAuth`/`requireAdmin`; the middleware can't import
 * `jsonwebtoken` (Edge runtime).
 *
 * The forced-password-rotation gate is mirrored here for UX: decode
 * the JWT claims unsafely (signature checked server-side) and route to
 * /password when the flag is set.
 *
 * The /api/v1/* ingest endpoints are exempt because they use bearer-
 * token auth, not cookies — they handle their own 401.
 */

const SESSION_COOKIE = "argus_session";

const PUBLIC_PATHS = new Set<string>(["/login"]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/api/auth/login")) return true;
  if (pathname.startsWith("/api/auth/logout")) return true;
  // Agent-facing ingest API uses its own bearer scheme.
  if (pathname.startsWith("/api/v1/")) return true;
  // Installer scripts must be curl-able from any target host.
  if (pathname.startsWith("/install/")) return true;
  if (pathname.startsWith("/_next")) return true;
  if (pathname === "/favicon.ico") return true;
  if (pathname.startsWith("/favicon")) return true;
  return false;
}

function isPasswordChangeFlow(pathname: string): boolean {
  if (pathname === "/password") return true;
  if (pathname.startsWith("/api/auth/change-password")) return true;
  if (pathname.startsWith("/api/auth/me")) return true;
  if (pathname.startsWith("/api/auth/logout")) return true;
  return false;
}

interface JwtClaims {
  mustChangePassword?: boolean;
}

function decodeJwtClaimsUnsafely(token: string): JwtClaims | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = segments[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;

  if (!token) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    if (pathname !== "/") {
      loginUrl.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  if (!isPasswordChangeFlow(pathname)) {
    const claims = decodeJwtClaimsUnsafely(token);
    if (claims?.mustChangePassword === true) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "must_change_password" },
          { status: 403 }
        );
      }
      const url = new URL("/password", req.url);
      if (pathname !== "/" && pathname !== "/password") {
        url.searchParams.set("next", pathname);
      }
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
