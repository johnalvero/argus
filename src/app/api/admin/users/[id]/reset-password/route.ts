import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  hashPassword,
  invalidateUserAuthCache,
  requireAdmin,
} from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  password?: string;
}

/**
 * POST /api/admin/users/[id]/reset-password — admin sets a new password
 * for another user. Forces mustChangePassword=1 and bumps tokenVersion
 * so any active sessions for that user are evicted on next request.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const targetId = Number(id);
  if (!Number.isFinite(targetId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const password = body.password ?? "";
  if (password.length < 8) {
    return NextResponse.json(
      { error: "password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.update({
    where: { id: targetId },
    data: {
      passwordHash,
      mustChangePassword: true,
      tokenVersion: { increment: 1 },
    },
  });
  invalidateUserAuthCache(targetId);

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "trigger",
    entityType: "user",
    entityId: String(targetId),
    summary: `reset password for "${target.email}" (forced rotation on next login)`,
  });

  return NextResponse.json({ ok: true });
}
