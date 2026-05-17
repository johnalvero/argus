import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import type { CveSyncRunRow } from "@/lib/types";

/**
 * GET /api/admin/cve/sync/[id] — detail for a single sync run. Used by
 * the (forthcoming) admin sync history page in B.1.b. Same row shape
 * as the list endpoint for consistency.
 *
 * Auth: admin JWT (cookie). Force-rotate gate still applies.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const row = await prisma.cveSyncRun.findUnique({
    where: { id },
    include: { triggeredBy: { select: { email: true } } },
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body: CveSyncRunRow = {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    status: row.status as CveSyncRunRow["status"],
    packagesQueried: row.packagesQueried,
    vulnsDiscovered: row.vulnsDiscovered,
    hostsAffected: row.hostsAffected,
    newVulns: row.newVulns,
    error: row.error,
    triggeredByEmail: row.triggeredBy?.email ?? null,
  };
  return NextResponse.json(body);
}
