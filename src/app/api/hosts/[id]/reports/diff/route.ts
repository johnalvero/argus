import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { computeReportDiff } from "@/lib/reportDiff";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/hosts/[id]/reports/diff?a=<reportId>&b=<reportId>
 *
 * Returns a compact, server-computed diff between two reports on the
 * same host. Both reports must belong to the host in the route param —
 * cross-host comparisons would be nonsensical and a 404 here is the
 * safest answer (don't disclose existence of unrelated reports).
 *
 * Computed on demand. We never pre-compute or cache diffs — almost no
 * one looks at them, the underlying payload pair is a stable URL
 * (browser cache handles back-navigation), and the heavy lift is just
 * JSON.parse + a couple of Map walks.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const hostId = Number(id);
  if (!Number.isFinite(hostId)) {
    return NextResponse.json({ error: "bad host id" }, { status: 400 });
  }

  const aParam = req.nextUrl.searchParams.get("a");
  const bParam = req.nextUrl.searchParams.get("b");
  const aId = Number(aParam);
  const bId = Number(bParam);
  if (!Number.isFinite(aId) || !Number.isFinite(bId)) {
    return NextResponse.json(
      { error: "a and b must be numeric report ids" },
      { status: 400 }
    );
  }
  if (aId === bId) {
    return NextResponse.json(
      { error: "a and b must be different reports" },
      { status: 400 }
    );
  }

  // Fetch both rows. `findMany` over an `in` clause is one round-trip
  // and lets us authorise the host scope in the same query.
  const rows = await prisma.report.findMany({
    where: { id: { in: [aId, bId] }, hostId },
    select: {
      id: true,
      payload: true,
      collectedAt: true,
      receivedAt: true,
    },
  });
  if (rows.length !== 2) {
    // Either id missing OR mismatched host. Same 404 either way —
    // don't disclose whether the report exists on a different host.
    return NextResponse.json(
      { error: "one or both reports not found for this host" },
      { status: 404 }
    );
  }

  const host = await prisma.host.findUnique({
    where: { id: hostId },
    select: { hostname: true },
  });
  if (!host) {
    return NextResponse.json({ error: "host not found" }, { status: 404 });
  }

  // Re-key by id so we lookup A and B explicitly (the `in` query
  // doesn't preserve param order).
  const byId = new Map(rows.map((r) => [r.id, r]));
  const a = byId.get(aId)!;
  const b = byId.get(bId)!;

  const result = computeReportDiff(a.payload, b.payload, {
    hostId,
    hostname: host.hostname,
    a: {
      reportId: a.id,
      collectedAt: a.collectedAt.toISOString(),
      receivedAt: a.receivedAt.toISOString(),
    },
    b: {
      reportId: b.id,
      collectedAt: b.collectedAt.toISOString(),
      receivedAt: b.receivedAt.toISOString(),
    },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result.diff);
}
