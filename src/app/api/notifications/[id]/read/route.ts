import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/notifications/[id]/read — mark this notification as read
 * for the current user. Upsert against the (notificationId, userId)
 * unique index so repeat calls are no-ops.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const nid = Number(id);
  if (!Number.isFinite(nid)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  // Visibility check — non-admins can only mark notifications belonging
  // to a watchlist they created. Returning 404 (rather than 403) avoids
  // leaking the existence of notifications they shouldn't see.
  if (!user.isAdmin) {
    const owned = await prisma.notification.findFirst({
      where: { id: nid, watchlist: { createdById: user.userId } },
      select: { id: true },
    });
    if (!owned) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }

  try {
    await prisma.notificationRead.upsert({
      where: {
        notificationId_userId: {
          notificationId: nid,
          userId: user.userId,
        },
      },
      create: {
        notificationId: nid,
        userId: user.userId,
      },
      update: {},
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // P2003 = FK violation → notification doesn't exist.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2003"
    ) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }
}
