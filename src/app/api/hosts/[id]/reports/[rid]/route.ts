import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

interface Ctx {
  params: Promise<{ id: string; rid: string }>;
}

/**
 * GET /api/hosts/[id]/reports/[rid] — returns the raw JSON payload of a
 * single historical report so the UI can show "what did this host look
 * like 3 days ago?". Loaded on demand only — they can run a few hundred
 * KB each.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id, rid } = await ctx.params;
  const hostId = Number(id);
  const reportId = Number(rid);
  if (!Number.isFinite(hostId) || !Number.isFinite(reportId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const report = await prisma.report.findFirst({
    where: { id: reportId, hostId },
    select: {
      id: true,
      payload: true,
      hash: true,
      collectedAt: true,
      receivedAt: true,
    },
  });
  if (!report) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: report.id,
    hash: report.hash,
    collectedAt: report.collectedAt.toISOString(),
    receivedAt: report.receivedAt.toISOString(),
    payload: report.payload,
  });
}
