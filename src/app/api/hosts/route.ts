import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { toSeverityBucket } from "@/lib/severity";

/**
 * GET /api/hosts — list every reporting host.
 *
 * Query: ?stale=N filters to hosts whose last report is older than N
 * hours. Useful for "what's gone dark?" sweeps.
 *
 * v1: no pagination. The spec assumes < 1000 hosts; one round-trip is
 * fine. Add cursor pagination when this hurts.
 *
 * Per-host CRITICAL/HIGH vuln counts are joined in for the dashboard
 * dot indicator. Only the two highest buckets ride along — anything
 * MEDIUM and below doesn't earn a glance-level indicator and bloating
 * this payload with full per-host severity histograms would slow the
 * list noticeably on fleets > 100 hosts.
 */
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const staleParam = url.searchParams.get("stale");
  let where: { lastReportAt?: { lt: Date } } = {};
  if (staleParam) {
    const hours = Number(staleParam);
    if (!Number.isFinite(hours) || hours <= 0) {
      return NextResponse.json(
        { error: "stale must be a positive number of hours" },
        { status: 400 }
      );
    }
    where = { lastReportAt: { lt: new Date(Date.now() - hours * 3_600_000) } };
  }

  const rows = await prisma.host.findMany({
    where,
    orderBy: { lastReportAt: "desc" },
    include: {
      _count: { select: { packages: true } },
      // Inline tag list per host. N hosts, M tags-per-host — one
      // joined read, no N+1. Ordered alphabetically so the chip rows
      // render deterministically without client-side sorting.
      tags: {
        include: { tag: true },
        orderBy: { tag: { name: "asc" } },
      },
    },
  });

  // Per-host CRITICAL/HIGH vuln counts. One grouped read joined back to
  // the host id map — avoids N+1 and stays a single SQL roundtrip for
  // the whole fleet. Counts the DISTINCT vuln per host (HostVulnerability
  // has at most one row per (host, vuln, package, version) anyway, but
  // a single vuln can affect a host via multiple package versions —
  // unlikely in practice, but we collapse to distinct vulnerabilityIds
  // to be conservative).
  const sevRows = await prisma.hostVulnerability.findMany({
    where: {
      vulnerability: { severity: { in: ["CRITICAL", "HIGH"] } },
    },
    select: {
      hostId: true,
      vulnerabilityId: true,
      vulnerability: { select: { severity: true } },
    },
  });
  const sevByHost = new Map<
    number,
    { CRITICAL: Set<number>; HIGH: Set<number> }
  >();
  for (const r of sevRows) {
    const bucket = toSeverityBucket(r.vulnerability.severity);
    if (bucket !== "CRITICAL" && bucket !== "HIGH") continue;
    let entry = sevByHost.get(r.hostId);
    if (!entry) {
      entry = { CRITICAL: new Set(), HIGH: new Set() };
      sevByHost.set(r.hostId, entry);
    }
    entry[bucket].add(r.vulnerabilityId);
  }

  return NextResponse.json(
    rows.map((h) => {
      const sev = sevByHost.get(h.id);
      return {
        id: h.id,
        hostId: h.hostId,
        hostname: h.hostname,
        osId: h.osId,
        osName: h.osName,
        osVersion: h.osVersion,
        osVersionCodename: h.osVersionCodename,
        kernel: h.kernel,
        arch: h.arch,
        packageManager: h.packageManager,
        agentVersion: h.agentVersion,
        privateIp: h.privateIp,
        firstSeenAt: h.firstSeenAt.toISOString(),
        lastReportAt: h.lastReportAt.toISOString(),
        packageCount: h._count.packages,
        tags: h.tags.map((ht) => ({
          id: ht.tag.id,
          name: ht.tag.name,
          color: ht.tag.color,
        })),
        vulnSeverityCounts: {
          CRITICAL: sev?.CRITICAL.size ?? 0,
          HIGH: sev?.HIGH.size ?? 0,
        },
      };
    })
  );
}
