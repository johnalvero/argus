import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  buildSessionCookie,
  checkLoginRateLimit,
  extractClientIp,
  signToken,
  verifyPassword,
} from "@/lib/auth";

interface LoginBody {
  email?: string;
  password?: string;
}

/**
 * Always emits the same "invalid credentials" message for unknown-user
 * and wrong-password cases so we don't leak which accounts exist. Also
 * runs `bcrypt.compare` against a fixed dummy hash on the unknown-user
 * path to equalise timing.
 */
export async function POST(req: NextRequest) {
  const ip = extractClientIp(req);
  const rl = checkLoginRateLimit(ip);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !password) {
    return NextResponse.json(
      { error: "email and password are required" },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Bcrypt-12 dummy hash. Keep timing consistent on unknown-user.
  const dummyHash =
    "$2b$12$CwTycUXWue0Thq9StjUM0uJ8Llo3xMr21n5rC6E1PYyE0uO0g.F6W";
  const ok = await verifyPassword(password, user?.passwordHash || dummyHash);

  if (!user || !ok) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const token = signToken({
    userId: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    tokenVersion: user.tokenVersion,
    mustChangePassword: user.mustChangePassword,
  });

  const res = NextResponse.json({
    id: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    mustChangePassword: user.mustChangePassword,
  });
  res.cookies.set(buildSessionCookie(token));
  return res;
}
