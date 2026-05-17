import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import { validateWatchlistPatch } from "@/lib/watchlistValidate";
import type { WatchlistKind } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * PATCH  /api/admin/watchlists/[id] — partial update. Any subset of
 *                                     name/description/enabled/kind/
 *                                     spec/channels/recipients.
 * DELETE                            — cascades through Notification.
 *
 * Audit hooks: drop on each successful mutation.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const wid = Number(id);
  if (!Number.isFinite(wid)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Need current kind for spec validation when kind isn't being changed.
  const before = await prisma.watchlist.findUnique({ where: { id: wid } });
  if (!before) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const result = await validateWatchlistPatch(raw, before.kind as WatchlistKind);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const v = result.value;

  const data: Prisma.WatchlistUpdateInput = {};
  if (v.name !== undefined) data.name = v.name;
  if (v.description !== undefined) data.description = v.description;
  if (v.enabled !== undefined) data.enabled = v.enabled;
  if (v.kind !== undefined) data.kind = v.kind;
  if (v.spec !== undefined) data.spec = JSON.stringify(v.spec);
  if (v.channels !== undefined) data.channels = JSON.stringify(v.channels);
  if (v.recipients !== undefined) {
    data.recipients = v.recipients ? JSON.stringify(v.recipients) : null;
  }

  try {
    const updated = await prisma.watchlist.update({
      where: { id: wid },
      data,
    });
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "update",
      entityType: "watchlist",
      entityId: String(updated.id),
      summary: `update watchlist "${updated.name}"`,
      diff: {
        before: { name: before.name, enabled: before.enabled },
        after: { name: updated.name, enabled: updated.enabled },
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2025") {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      if (err.code === "P2002") {
        return NextResponse.json(
          { error: `watchlist name already exists` },
          { status: 409 }
        );
      }
    }
    throw err;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const wid = Number(id);
  if (!Number.isFinite(wid)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const existing = await prisma.watchlist.findUnique({
    where: { id: wid },
    include: { _count: { select: { notifications: true } } },
  });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await prisma.watchlist.delete({ where: { id: wid } });

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "delete",
    entityType: "watchlist",
    entityId: String(wid),
    summary: `delete watchlist "${existing.name}" (${existing._count.notifications} notifications cascade)`,
    diff: {
      before: { name: existing.name, kind: existing.kind },
      after: null,
    },
  });

  return NextResponse.json({
    ok: true,
    notificationsRemoved: existing._count.notifications,
  });
}
