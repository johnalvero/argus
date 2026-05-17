import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { parseReportPayload } from "@/lib/reportPayload";
import { severityRank, toSeverityBucket } from "@/lib/severity";
import type {
  ContainerEntry,
  ContainerRuntimeEntry,
  HostVulnerabilitySummary,
  KernelMitigationEntry,
  ListenerEntry,
  LoadedModuleEntry,
  PendingUpdates,
  ServiceEntry,
  UptimeInfo,
  VirtualizationInfo,
} from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/hosts/[id] — full host detail: latest report's
 * packages/services/listeners/containers, plus history of report
 * metadata (timestamps + size). The raw payload is fetched on demand
 * via /api/hosts/[id]/reports/[rid].
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const hostId = Number(id);
  if (!Number.isFinite(hostId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const host = await prisma.host.findUnique({
    where: { id: hostId },
    include: {
      packages: { orderBy: [{ name: "asc" }, { version: "asc" }] },
      reports: { orderBy: { receivedAt: "desc" }, take: 50 },
      tags: {
        include: { tag: true },
        orderBy: { tag: { name: "asc" } },
      },
      vulnerabilities: {
        include: {
          vulnerability: {
            select: {
              id: true,
              osvId: true,
              severity: true,
              summary: true,
            },
          },
        },
      },
    },
  });
  if (!host) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Severity desc, then osvId asc. Stable + matches the spec for the
  // host-detail vulnerability section.
  const vulnerabilities: HostVulnerabilitySummary[] = host.vulnerabilities
    .map((hv) => ({
      id: hv.vulnerability.id,
      osvId: hv.vulnerability.osvId,
      severity: hv.vulnerability.severity,
      summary: hv.vulnerability.summary,
      packageName: hv.packageName,
      packageVersion: hv.packageVersion,
      ecosystem: hv.ecosystem,
    }))
    .sort((a, b) => {
      const rankDelta = severityRank(b.severity) - severityRank(a.severity);
      if (rankDelta !== 0) return rankDelta;
      return a.osvId.localeCompare(b.osvId);
    });

  // CRITICAL/HIGH per-host counts. Mirror the shape /api/hosts ships so
  // the host detail page's quick-summary strip is consistent with the
  // dashboard dot indicator. Distinct vuln ids per bucket.
  const vulnSeverityCounts = (() => {
    const crit = new Set<number>();
    const high = new Set<number>();
    for (const hv of host.vulnerabilities) {
      const bucket = toSeverityBucket(hv.vulnerability.severity);
      if (bucket === "CRITICAL") crit.add(hv.vulnerability.id);
      else if (bucket === "HIGH") high.add(hv.vulnerability.id);
    }
    return { CRITICAL: crit.size, HIGH: high.size };
  })();

  // Latest report drives services/listeners/containers. Packages we
  // serve from the denormalised HostPackage table — faster and pre-
  // deduped.
  const latest = host.reports[0];
  let services: ServiceEntry[] = [];
  let listeners: ListenerEntry[] = [];
  let containers: ContainerEntry[] = [];
  let kernelMitigations: KernelMitigationEntry[] | undefined;
  let loadedModules: LoadedModuleEntry[] | undefined;
  let pendingUpdates: PendingUpdates | undefined;
  let containerRuntime: ContainerRuntimeEntry[] | undefined;
  let virtualization: VirtualizationInfo | undefined;
  let uptime: UptimeInfo | undefined;
  if (latest) {
    try {
      const parsed = parseReportPayload(JSON.parse(latest.payload));
      if (parsed.ok) {
        services = parsed.data.services ?? [];
        listeners = parsed.data.listeners ?? [];
        containers = parsed.data.containers ?? [];
        // Security & posture — pass through as-is. Absent fields stay
        // absent so the UI can render-or-skip per section.
        kernelMitigations = parsed.data.kernel_mitigations;
        loadedModules = parsed.data.loaded_modules;
        pendingUpdates = parsed.data.pending_updates;
        containerRuntime = parsed.data.container_runtime;
        virtualization = parsed.data.virtualization;
        uptime = parsed.data.uptime;
      }
    } catch {
      // Malformed historical payload — treat as empty optional inventories.
    }
  }

  return NextResponse.json({
    id: host.id,
    hostId: host.hostId,
    hostname: host.hostname,
    osId: host.osId,
    osName: host.osName,
    osVersion: host.osVersion,
    osVersionCodename: host.osVersionCodename,
    kernel: host.kernel,
    arch: host.arch,
    packageManager: host.packageManager,
    agentVersion: host.agentVersion,
    privateIp: host.privateIp,
    // Parsed JSON array of {iface, addr} from the latest payload. Empty
    // on null / malformed.
    ipAddresses: (() => {
      if (!host.ipAddresses) return [] as { iface: string; addr: string }[];
      try {
        const arr = JSON.parse(host.ipAddresses);
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    })(),
    firstSeenAt: host.firstSeenAt.toISOString(),
    lastReportAt: host.lastReportAt.toISOString(),
    packageCount: host.packages.length,
    tags: host.tags.map((ht) => ({
      id: ht.tag.id,
      name: ht.tag.name,
      color: ht.tag.color,
    })),
    packages: host.packages.map((p) => ({
      ecosystem: p.ecosystem,
      location: p.location,
      name: p.name,
      version: p.version,
      arch: p.arch,
    })),
    services,
    listeners,
    containers,
    kernelMitigations,
    loadedModules,
    pendingUpdates,
    containerRuntime,
    virtualization,
    uptime,
    reports: host.reports.map((r) => ({
      id: r.id,
      collectedAt: r.collectedAt.toISOString(),
      receivedAt: r.receivedAt.toISOString(),
      hash: r.hash,
      payloadSize: r.payload.length,
    })),
    vulnerabilities,
    vulnSeverityCounts,
  });
}
