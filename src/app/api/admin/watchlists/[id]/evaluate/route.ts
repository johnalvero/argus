import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import { evaluateWatchlists } from "@/lib/watchlists";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/admin/watchlists/[id]/evaluate — run evaluation now.
 *
 * We run evaluateWatchlists() across all enabled watchlists rather
 * than the targeted one — the eval logic is cheap relative to set-up,
 * and a single-watchlist API would be a second code path to maintain.
 * The audit row records which watchlist the operator triggered from.
 *
 * Returns { evaluated, triggered }.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const wid = Number(id);
  if (!Number.isFinite(wid)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const w = await prisma.watchlist.findUnique({ where: { id: wid } });
  if (!w) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const result = await evaluateWatchlists("manual");
  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "trigger",
    entityType: "watchlist",
    entityId: String(wid),
    summary: `manual evaluation triggered from watchlist "${w.name}" (${result.evaluated} evaluated, ${result.triggered} new notifications)`,
  });

  return NextResponse.json(result);
}
