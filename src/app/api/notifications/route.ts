import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import type {
  NotificationListResponse,
  NotificationRow,
  NotificationSeverity,
} from "@/lib/types";

/**
 * GET /api/notifications — current user's notifications, joined with
 * NotificationRead so the bell can render per-user read state without
 * a second call.
 *
 * Query:
 *   - limit       1..200 (default 50)
 *   - unread      "1" to filter to unread only
 *   - watchlistId optional watchlist filter
 *
 * Returns { items, unreadCount } where unreadCount is the TOTAL
 * unread for this user (not just on the current page) — drives the
 * header badge regardless of which slice the page requested.
 *
 * Visibility scoping (M4): non-admins only see notifications belonging
 * to watchlists they created. Admins see everything. This prevents an
 * ordinary user from observing another team's vulnerability watch
 * traffic just because they have a login.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const url = req.nextUrl;
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(MAX_LIMIT, Math.floor(limitRaw))
      : DEFAULT_LIMIT;
  const unreadOnly = url.searchParams.get("unread") === "1";
  const watchlistIdRaw = url.searchParams.get("watchlistId");
  const watchlistId = watchlistIdRaw ? Number(watchlistIdRaw) : null;

  // Visibility filter — admins see everything, non-admins only see
  // notifications from watchlists they created. Encoded as a Prisma
  // relation filter so SQLite does the scoping at index time.
  const visibilityWhere = user.isAdmin
    ? {}
    : { watchlist: { createdById: user.userId } };

  // Pull the candidate set first. For unread filtering we left-join
  // NotificationRead and filter the absence in JS — keeps the Prisma
  // query a single .findMany rather than wrestling with NULL semantics
  // in the where.
  const rows = await prisma.notification.findMany({
    where: {
      ...visibilityWhere,
      ...(watchlistId && Number.isFinite(watchlistId)
        ? { watchlistId }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: unreadOnly ? Math.min(MAX_LIMIT, limit * 4) : limit,
    include: {
      watchlist: { select: { name: true } },
      readBy: {
        where: { userId: user.userId },
        select: { id: true },
      },
    },
  });

  const filtered = unreadOnly
    ? rows.filter((r) => r.readBy.length === 0).slice(0, limit)
    : rows.slice(0, limit);

  const items: NotificationRow[] = filtered.map((r) => ({
    id: r.id,
    watchlistId: r.watchlistId,
    watchlistName: r.watchlist?.name ?? "",
    title: r.title,
    body: r.body,
    href: r.href,
    severity: r.severity as NotificationSeverity,
    emailedAt: r.emailedAt ? r.emailedAt.toISOString() : null,
    emailError: r.emailError,
    isRead: r.readBy.length > 0,
    createdAt: r.createdAt.toISOString(),
  }));

  // Total unread for this user — bell badge value. Scoped the same way
  // as the list, so a non-admin's badge counts only their own watchlists.
  const totalVisible = await prisma.notification.count({
    where: visibilityWhere,
  });
  const readVisible = await prisma.notificationRead.count({
    where: {
      userId: user.userId,
      ...(user.isAdmin
        ? {}
        : { notification: { watchlist: { createdById: user.userId } } }),
    },
  });
  const unreadCount = Math.max(0, totalVisible - readVisible);

  const body: NotificationListResponse = { items, unreadCount };
  return NextResponse.json(body);
}
