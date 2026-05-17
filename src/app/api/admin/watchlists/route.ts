import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import { validateWatchlistInput } from "@/lib/watchlistValidate";
import type {
  NotificationChannel,
  WatchlistKind,
  WatchlistRow,
  WatchlistSpec,
} from "@/lib/types";

/**
 * GET  /api/admin/watchlists — list every watchlist with eval status
 *                              and recent (last 7d) notification count.
 * POST                       — create a watchlist.
 *
 * Admin-only. Audit hooks: drop on every successful mutation.
 */

const RECENT_WINDOW_MS = 7 * 86_400_000;

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const rows = await prisma.watchlist.findMany({
    orderBy: { name: "asc" },
    include: {
      createdBy: { select: { email: true } },
    },
  });

  // One bulk count for recent notifications across all watchlists,
  // grouped so the response doesn't fan out N queries.
  const since = new Date(Date.now() - RECENT_WINDOW_MS);
  const recentCounts = await prisma.notification.groupBy({
    by: ["watchlistId"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  const recentByWatchlist = new Map<number, number>();
  for (const r of recentCounts) {
    recentByWatchlist.set(r.watchlistId, r._count._all);
  }

  const body: WatchlistRow[] = rows.map((w) => {
    const spec = safeParse<WatchlistSpec>(w.spec, {
      kind: w.kind as WatchlistKind,
    } as unknown as WatchlistSpec);
    const channels = safeParse<NotificationChannel[]>(w.channels, ["inapp"]);
    const recipients = w.recipients
      ? safeParse<string[]>(w.recipients, [])
      : null;
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      enabled: w.enabled,
      kind: w.kind as WatchlistKind,
      spec,
      channels,
      recipients,
      createdByEmail: w.createdBy?.email ?? "",
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
      lastEvaluatedAt: w.lastEvaluatedAt
        ? w.lastEvaluatedAt.toISOString()
        : null,
      matchCount: w.matchCount,
      recentNotificationCount: recentByWatchlist.get(w.id) ?? 0,
    };
  });
  return NextResponse.json(body);
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await validateWatchlistInput(raw);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const v = result.value;

  try {
    const created = await prisma.watchlist.create({
      data: {
        name: v.name,
        description: v.description,
        enabled: v.enabled,
        kind: v.kind,
        spec: JSON.stringify(v.spec),
        channels: JSON.stringify(v.channels),
        recipients: v.recipients ? JSON.stringify(v.recipients) : null,
        createdById: user.userId,
      },
    });
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "create",
      entityType: "watchlist",
      entityId: String(created.id),
      summary: `create watchlist "${created.name}" (${created.kind})`,
      diff: {
        before: null,
        after: {
          name: created.name,
          kind: created.kind,
          channels: v.channels,
        },
      },
    });
    return NextResponse.json(
      { id: created.id, name: created.name },
      { status: 201 }
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { error: `watchlist "${v.name}" already exists` },
        { status: 409 }
      );
    }
    throw err;
  }
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
