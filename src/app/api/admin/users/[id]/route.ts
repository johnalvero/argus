import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { invalidateUserAuthCache, requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * DELETE /api/admin/users/[id] — remove a UI user.
 *
 * Guards:
 *   - cannot delete yourself
 *   - cannot delete the last admin
 *
 * IngestToken.createdById carries a required FK; reassign that user's
 * tokens to the acting admin so we keep the audit trail intact rather
 * than cascading.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const targetId = Number(id);
  if (!Number.isFinite(targetId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  if (targetId === user.userId) {
    return NextResponse.json(
      { error: "cannot delete yourself" },
      { status: 400 }
    );
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (target.isAdmin) {
    const remainingAdmins = await prisma.user.count({
      where: { isAdmin: true, id: { not: targetId } },
    });
    if (remainingAdmins === 0) {
      return NextResponse.json(
        { error: "cannot delete the last admin" },
        { status: 400 }
      );
    }
  }

  await prisma.ingestToken.updateMany({
    where: { createdById: targetId },
    data: { createdById: user.userId },
  });
  await prisma.user.delete({ where: { id: targetId } });
  invalidateUserAuthCache(targetId);

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "delete",
    entityType: "user",
    entityId: String(targetId),
    summary: `delete user "${target.email}"${target.isAdmin ? " (admin)" : ""}`,
    diff: {
      before: { email: target.email, isAdmin: target.isAdmin },
      after: null,
    },
  });

  return NextResponse.json({ ok: true });
}
