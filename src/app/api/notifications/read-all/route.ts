import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * POST /api/notifications/read-all — mark everything currently
 * unread-by-this-user as read. We compute the set of notification ids
 * the user hasn't read yet and createMany the NotificationRead rows in
 * one shot. skipDuplicates handles the race where two tabs hit this
 * concurrently.
 */
export async function POST(req: NextRequest) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const already = await prisma.notificationRead.findMany({
    where: { userId: user.userId },
    select: { notificationId: true },
  });
  const alreadySet = new Set(already.map((r) => r.notificationId));

  // Visibility scope mirrors GET /api/notifications — a non-admin
  // marking "all read" only marks their own watchlists' notifications,
  // not the global firehose.
  const all = await prisma.notification.findMany({
    where: user.isAdmin
      ? {}
      : { watchlist: { createdById: user.userId } },
    select: { id: true },
  });
  const toInsert = all
    .filter((n) => !alreadySet.has(n.id))
    .map((n) => ({ notificationId: n.id, userId: user.userId }));

  if (toInsert.length === 0) {
    return NextResponse.json({ ok: true, marked: 0 });
  }

  // SQLite + Prisma's createMany has no skipDuplicates support, so
  // upsert one-by-one inside a transaction. The unique index makes
  // each call idempotent if a concurrent tab beats us to it.
  let marked = 0;
  await prisma.$transaction(
    toInsert.map((row) =>
      prisma.notificationRead.upsert({
        where: {
          notificationId_userId: {
            notificationId: row.notificationId,
            userId: row.userId,
          },
        },
        create: row,
        update: {},
      })
    )
  );
  marked = toInsert.length;
  return NextResponse.json({ ok: true, marked });
}
