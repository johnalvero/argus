import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  buildSessionCookie,
  hashPassword,
  invalidateUserAuthCache,
  requireAuth,
  signToken,
  verifyPassword,
} from "@/lib/auth";

interface PostBody {
  currentPassword?: string;
  newPassword?: string;
}

const MIN_NEW_PASSWORD_LENGTH = 12;

export async function POST(req: NextRequest) {
  // This endpoint IS the password-change gate, so allow callers whose
  // mustChangePassword flag is set.
  const authed = await requireAuth(req, { allowMustChangePassword: true });
  if (authed instanceof NextResponse) return authed;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const currentPassword = body.currentPassword ?? "";
  const newPassword = body.newPassword ?? "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: "currentPassword and newPassword are required" },
      { status: 400 }
    );
  }
  if (newPassword.length < MIN_NEW_PASSWORD_LENGTH) {
    return NextResponse.json(
      {
        error: `newPassword must be at least ${MIN_NEW_PASSWORD_LENGTH} characters`,
      },
      { status: 400 }
    );
  }
  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: "newPassword must differ from currentPassword" },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({ where: { id: authed.userId } });
  if (!user) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: "currentPassword is incorrect" },
      { status: 401 }
    );
  }

  const passwordHash = await hashPassword(newPassword);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      mustChangePassword: false,
      // Bump tokenVersion to evict any other sessions; we re-issue this
      // caller a fresh cookie below so they don't get logged out here.
      tokenVersion: { increment: 1 },
    },
  });

  invalidateUserAuthCache(user.id);

  const token = signToken({
    userId: updated.id,
    email: updated.email,
    isAdmin: updated.isAdmin,
    tokenVersion: updated.tokenVersion,
    mustChangePassword: updated.mustChangePassword,
  });

  const res = NextResponse.json({
    ok: true,
    id: updated.id,
    email: updated.email,
    isAdmin: updated.isAdmin,
    mustChangePassword: updated.mustChangePassword,
  });
  res.cookies.set(buildSessionCookie(token));
  return res;
}
