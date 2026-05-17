import { prisma } from "@/lib/db";
import { getCollectorConfig } from "@/lib/collectorConfig";
import { parseReportPayload } from "@/lib/reportPayload";
import { readScript } from "@/app/install/_lib/readScript";
import { toSeverityBucket } from "@/lib/severity";
import type {
  CompliancePatchSection,
  CompliancePostureSection,
  ComplianceReportingSection,
  ComplianceResponse,
  ComplianceTone,
  ComplianceVulnSection,
  ComplianceGrade,
} from "@/lib/types";

/**
 * Shared compliance scoring engine. Lifted out of
 * `src/app/api/compliance/route.ts` so the dashboard endpoint can reuse
 * the exact same scoring without duplicating logic. The route now just
 * parses the request, calls `computeCompliance({ tagIds })`, and
 * returns the result.
 *
 * Scoring weights — vulns lead because they're the highest signal-to-
 * noise metric; the other three are operational hygiene.
 */
export const COMPLIANCE_WEIGHTS = {
  vulnerabilities: 0.4,
  reporting: 0.2,
  posture: 0.2,
  patches: 0.2,
} as const;

export function gradeFor(score: number): ComplianceGrade {
  if (score >= 95) return "A";
  if (score >= 85) return "B";
  if (score >= 70) return "C";
  if (score >= 50) return "D";
  return "F";
}

/** Section score = 100 * compliant/total, rounded. Safe with total=0. */
export function pct(compliant: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round((100 * compliant) / total);
}

function tone(value: number, total: number, kind: "bad" | "warn"): ComplianceTone {
  if (total === 0) return "neutral";
  if (value === 0) return "good";
  return kind;
}

// ─── Agent version (cached alongside readScript's 60s cache) ─────────────
interface AgentVersionCacheEntry {
  version: string | null;
  expiresAt: number;
}
let agentVersionCache: AgentVersionCacheEntry | null = null;
const AGENT_VERSION_TTL_MS = 60_000;

export async function getCurrentAgentVersion(): Promise<string | null> {
  const now = Date.now();
  if (agentVersionCache && agentVersionCache.expiresAt > now) {
    return agentVersionCache.version;
  }
  let version: string | null = null;
  try {
    const body = await readScript("agent");
    const m = body.match(/^\s*AGENT_VERSION=["']?([0-9]+\.[0-9]+(?:\.[0-9]+)?)["']?\s*$/m);
    if (m) version = m[1] ?? null;
  } catch {
    version = null;
  }
  agentVersionCache = { version, expiresAt: now + AGENT_VERSION_TTL_MS };
  return version;
}

/** Strict less-than current major.minor → "old". */
export function isOldAgent(version: string | null, current: string | null): boolean {
  if (!current) return false;
  if (!version) return true;
  const parse = (v: string): [number, number] | null => {
    const parts = v.split(".").map((p) => Number(p));
    if (parts.length < 2) return null;
    const [maj, min] = parts;
    if (!Number.isFinite(maj!) || !Number.isFinite(min!)) return null;
    return [maj!, min!];
  };
  const a = parse(version);
  const b = parse(current);
  if (!a || !b) return false;
  if (a[0] < b[0]) return true;
  if (a[0] > b[0]) return false;
  return a[1] < b[1];
}

export interface ComputeComplianceOptions {
  /** Tag-id intersection filter. Empty = full fleet. */
  tagIds?: number[];
  /**
   * When true, includes operationally-detailed fields (`topVulns`,
   * `agentVersionDistribution`) in the response. Non-admin callers
   * still see the composite score + per-section scores so the
   * dashboard tile and grade remain meaningful, but they don't get
   * the fleet-wide CVE list.
   */
  includeAdminDetail?: boolean;
}

/**
 * Compute the full ComplianceResponse for a host scope. Used by both
 * `/api/compliance` (per request, with tag filter) and `/api/dashboard`
 * (fleet-wide, no filter).
 */
export async function computeCompliance(
  opts: ComputeComplianceOptions = {}
): Promise<ComplianceResponse> {
  const tagIds = opts.tagIds ?? [];
  const includeAdminDetail = opts.includeAdminDetail ?? false;

  const cfg = await getCollectorConfig();
  const currentAgentVersion = await getCurrentAgentVersion();

  const hostWhere =
    tagIds.length > 0
      ? { tags: { some: { tagId: { in: tagIds } } } }
      : {};

  const hosts = await prisma.host.findMany({
    where: hostWhere,
    select: {
      id: true,
      agentVersion: true,
      lastReportAt: true,
    },
  });
  const hostIds = hosts.map((h) => h.id);
  const hostCount = hosts.length;
  const generatedAt = new Date().toISOString();

  if (hostCount === 0) {
    const emptySummary = "No hosts in scope.";
    return {
      scope: { hostCount: 0, tagIds },
      generatedAt,
      composite: { score: 100, grade: "A" },
      sections: {
        vulnerabilities: {
          title: "Vulnerabilities",
          score: 100,
          grade: "A",
          weight: COMPLIANCE_WEIGHTS.vulnerabilities,
          summary: emptySummary,
          metrics: [],
          hostsWithCritical: 0,
          hostsWithHigh: 0,
          hostsClean: 0,
          topVulns: [],
        },
        reporting: {
          title: "Reporting",
          score: 100,
          grade: "A",
          weight: COMPLIANCE_WEIGHTS.reporting,
          summary: emptySummary,
          metrics: [],
          hostsActive: 0,
          hostsStale: 0,
          hostsDead: 0,
          hostsRunningOldAgent: 0,
          agentVersionDistribution: [],
        },
        posture: {
          title: "Posture",
          score: 100,
          grade: "A",
          weight: COMPLIANCE_WEIGHTS.posture,
          summary: emptySummary,
          metrics: [],
          hostsWithKernelMitigationsArmed: 0,
          hostsWithoutKernelMitigations: 0,
          virtCoverage: 0,
          uptimeCoverage: 0,
          containerHostCount: 0,
        },
        patches: {
          title: "Patches",
          score: 100,
          grade: "A",
          weight: COMPLIANCE_WEIGHTS.patches,
          summary: emptySummary,
          metrics: [],
          hostsWithPendingUpdates: 0,
          hostsCleanPatches: 0,
          hostsUnknownPatchStatus: 0,
          totalPendingUpdates: 0,
        },
      },
    };
  }

  // ─── Vulnerabilities ──────────────────────────────────────────────────
  const hvRows = await prisma.hostVulnerability.findMany({
    where: {
      hostId: { in: hostIds },
      vulnerability: { severity: { in: ["CRITICAL", "HIGH"] } },
    },
    select: {
      hostId: true,
      vulnerabilityId: true,
      vulnerability: {
        select: { id: true, osvId: true, severity: true },
      },
    },
  });
  const hostsCrit = new Set<number>();
  const hostsHigh = new Set<number>();
  const hostsPerVuln = new Map<
    number,
    { osvId: string; severity: string; hosts: Set<number> }
  >();
  for (const r of hvRows) {
    const bucket = toSeverityBucket(r.vulnerability.severity);
    if (bucket === "CRITICAL") hostsCrit.add(r.hostId);
    else if (bucket === "HIGH") hostsHigh.add(r.hostId);
    let entry = hostsPerVuln.get(r.vulnerability.id);
    if (!entry) {
      entry = {
        osvId: r.vulnerability.osvId,
        severity: r.vulnerability.severity ?? "UNKNOWN",
        hosts: new Set(),
      };
      hostsPerVuln.set(r.vulnerability.id, entry);
    }
    entry.hosts.add(r.hostId);
  }
  const hostsWithCriticalOrHigh = new Set<number>([
    ...hostsCrit,
    ...hostsHigh,
  ]);
  const hostsCleanVulns = hostCount - hostsWithCriticalOrHigh.size;
  const vulnScore = pct(hostsCleanVulns, hostCount);
  const topVulns = includeAdminDetail
    ? Array.from(hostsPerVuln.entries())
        .map(([id, v]) => ({
          id,
          osvId: v.osvId,
          severity: v.severity,
          hostCount: v.hosts.size,
        }))
        .sort(
          (a, b) => b.hostCount - a.hostCount || a.osvId.localeCompare(b.osvId)
        )
        .slice(0, 5)
    : [];

  const vulnSection: ComplianceVulnSection = {
    title: "Vulnerabilities",
    score: vulnScore,
    grade: gradeFor(vulnScore),
    weight: COMPLIANCE_WEIGHTS.vulnerabilities,
    summary:
      hostsCrit.size > 0
        ? `${hostsCrit.size} host${hostsCrit.size === 1 ? "" : "s"} have CRITICAL vulnerabilities`
        : hostsHigh.size > 0
          ? `${hostsHigh.size} host${hostsHigh.size === 1 ? "" : "s"} have HIGH vulnerabilities`
          : "No CRITICAL or HIGH vulnerabilities in scope.",
    metrics: [
      {
        label: "Hosts with CRITICAL",
        value: hostsCrit.size,
        tone: tone(hostsCrit.size, hostCount, "bad"),
      },
      {
        label: "Hosts with HIGH",
        value: hostsHigh.size,
        tone: tone(hostsHigh.size, hostCount, "warn"),
      },
      {
        label: "Hosts clean (no C/H)",
        value: hostsCleanVulns,
        tone: hostsCleanVulns === hostCount ? "good" : "neutral",
      },
      {
        label: "Hosts in scope",
        value: hostCount,
        tone: "neutral",
      },
    ],
    hostsWithCritical: hostsCrit.size,
    hostsWithHigh: hostsHigh.size,
    hostsClean: hostsCleanVulns,
    topVulns,
  };

  // ─── Reporting ────────────────────────────────────────────────────────
  const now = Date.now();
  const amberMs = cfg.staleHostAmberDays * 86_400_000;
  const redMs = cfg.staleHostRedDays * 86_400_000;
  let hostsActive = 0;
  let hostsStale = 0;
  let hostsDead = 0;
  let hostsRunningOldAgent = 0;
  const versionCounts = new Map<string, number>();
  for (const h of hosts) {
    const ageMs = now - h.lastReportAt.getTime();
    if (ageMs <= amberMs) hostsActive++;
    else if (ageMs <= redMs) hostsStale++;
    else hostsDead++;
    if (isOldAgent(h.agentVersion, currentAgentVersion)) {
      hostsRunningOldAgent++;
    }
    const key = h.agentVersion ?? "unknown";
    versionCounts.set(key, (versionCounts.get(key) ?? 0) + 1);
  }
  let reportingCompliant = 0;
  for (const h of hosts) {
    const ageMs = now - h.lastReportAt.getTime();
    if (ageMs > amberMs) continue;
    if (isOldAgent(h.agentVersion, currentAgentVersion)) continue;
    reportingCompliant++;
  }
  const reportingScore = pct(reportingCompliant, hostCount);
  const agentVersionDistribution = includeAdminDetail
    ? Array.from(versionCounts.entries())
        .map(([version, count]) => ({ version, count }))
        .sort((a, b) => b.count - a.count || a.version.localeCompare(b.version))
    : [];

  const reportingSection: ComplianceReportingSection = {
    title: "Reporting",
    score: reportingScore,
    grade: gradeFor(reportingScore),
    weight: COMPLIANCE_WEIGHTS.reporting,
    summary:
      hostsDead > 0
        ? `${hostsDead} host${hostsDead === 1 ? "" : "s"} have gone dark.`
        : hostsStale > 0
          ? `${hostsStale} host${hostsStale === 1 ? "" : "s"} reporting late.`
          : hostsRunningOldAgent > 0
            ? `${hostsRunningOldAgent} host${hostsRunningOldAgent === 1 ? "" : "s"} on an old agent.`
            : "All hosts reporting on time.",
    metrics: [
      { label: "Active", value: hostsActive, tone: "good" },
      {
        label: "Stale",
        value: hostsStale,
        tone: tone(hostsStale, hostCount, "warn"),
      },
      {
        label: "Dead",
        value: hostsDead,
        tone: tone(hostsDead, hostCount, "bad"),
      },
      {
        label: "Old agent",
        value: hostsRunningOldAgent,
        tone: tone(hostsRunningOldAgent, hostCount, "warn"),
      },
      {
        label: "Current agent",
        value: currentAgentVersion ?? "unknown",
        tone: "neutral",
      },
    ],
    hostsActive,
    hostsStale,
    hostsDead,
    hostsRunningOldAgent,
    agentVersionDistribution,
  };

  // ─── Posture & patches ────────────────────────────────────────────────
  const latestReports = await prisma.report.findMany({
    where: { hostId: { in: hostIds } },
    orderBy: [{ hostId: "asc" }, { receivedAt: "desc" }],
    select: { hostId: true, payload: true, receivedAt: true },
  });
  const latestByHost = new Map<number, string>();
  for (const r of latestReports) {
    if (!latestByHost.has(r.hostId)) latestByHost.set(r.hostId, r.payload);
  }

  let hostsKernelMitArmed = 0;
  let hostsVirt = 0;
  let hostsUptime = 0;
  let hostsContainerRuntime = 0;
  let hostsWithPendingUpdates = 0;
  let hostsCleanPatches = 0;
  let hostsUnknownPatchStatus = 0;
  let totalPendingUpdates = 0;
  let hostsPosturePresent = 0;

  for (const h of hosts) {
    const raw = latestByHost.get(h.id);
    let kernelMit = false;
    let virt = false;
    let uptime = false;
    let containerRt = false;
    let patchPresent = false;
    let patchCount: number | null = null;
    if (raw) {
      try {
        const parsed = parseReportPayload(JSON.parse(raw));
        if (parsed.ok) {
          const p = parsed.data;
          if (p.kernel_mitigations && p.kernel_mitigations.length > 0) {
            kernelMit = true;
          }
          if (p.virtualization) virt = true;
          if (p.uptime) uptime = true;
          if (p.container_runtime && p.container_runtime.length > 0) {
            containerRt = true;
          }
          if (p.pending_updates) {
            patchPresent = true;
            patchCount = p.pending_updates.count ?? 0;
          }
        }
      } catch {
        // ignore malformed payload
      }
    }
    if (kernelMit) hostsKernelMitArmed++;
    if (virt) hostsVirt++;
    if (uptime) hostsUptime++;
    if (containerRt) hostsContainerRuntime++;

    const requireKernelMit = cfg.collectKernelMitigations;
    const requireVirt = cfg.collectVirtualization;
    const kernelOk = !requireKernelMit || kernelMit;
    const virtOk = !requireVirt || virt;
    if (kernelOk && virtOk) hostsPosturePresent++;

    if (patchPresent) {
      if (patchCount === 0) hostsCleanPatches++;
      else {
        hostsWithPendingUpdates++;
        totalPendingUpdates += patchCount ?? 0;
      }
    } else {
      hostsUnknownPatchStatus++;
    }
  }

  const hostsWithoutKernelMit = hostCount - hostsKernelMitArmed;
  const postureScore = pct(hostsPosturePresent, hostCount);

  const postureSection: CompliancePostureSection = {
    title: "Posture",
    score: postureScore,
    grade: gradeFor(postureScore),
    weight: COMPLIANCE_WEIGHTS.posture,
    summary:
      !cfg.collectKernelMitigations && !cfg.collectVirtualization
        ? "Posture collectors disabled — no compliance requirement."
        : hostsWithoutKernelMit > 0 && cfg.collectKernelMitigations
          ? `${hostsWithoutKernelMit} host${hostsWithoutKernelMit === 1 ? "" : "s"} missing kernel mitigation data.`
          : "Posture data present across the fleet.",
    metrics: [
      {
        label: "Kernel mitigations armed",
        value: hostsKernelMitArmed,
        tone: cfg.collectKernelMitigations
          ? hostsKernelMitArmed === hostCount
            ? "good"
            : "warn"
          : "neutral",
      },
      {
        label: "Missing mitigations",
        value: hostsWithoutKernelMit,
        tone: cfg.collectKernelMitigations
          ? tone(hostsWithoutKernelMit, hostCount, "warn")
          : "neutral",
      },
      {
        label: "Virtualization coverage",
        value: hostsVirt,
        tone: cfg.collectVirtualization
          ? hostsVirt === hostCount
            ? "good"
            : "warn"
          : "neutral",
      },
      {
        label: "Uptime coverage",
        value: hostsUptime,
        tone: "neutral",
      },
      {
        label: "Container hosts",
        value: hostsContainerRuntime,
        tone: "neutral",
      },
    ],
    hostsWithKernelMitigationsArmed: hostsKernelMitArmed,
    hostsWithoutKernelMitigations: hostsWithoutKernelMit,
    virtCoverage: hostsVirt,
    uptimeCoverage: hostsUptime,
    containerHostCount: hostsContainerRuntime,
  };

  const patchScore = cfg.collectPendingUpdates
    ? pct(hostsCleanPatches, hostCount)
    : 100;
  const patchSection: CompliancePatchSection = {
    title: "Patches",
    score: patchScore,
    grade: gradeFor(patchScore),
    weight: COMPLIANCE_WEIGHTS.patches,
    summary: !cfg.collectPendingUpdates
      ? "Pending-updates collector disabled — patch status unknown."
      : hostsWithPendingUpdates > 0
        ? `${hostsWithPendingUpdates} host${hostsWithPendingUpdates === 1 ? "" : "s"} have pending updates (${totalPendingUpdates} total).`
        : hostsUnknownPatchStatus > 0
          ? `${hostsUnknownPatchStatus} host${hostsUnknownPatchStatus === 1 ? "" : "s"} not reporting patch status.`
          : "All hosts fully patched.",
    metrics: [
      {
        label: "Pending updates",
        value: hostsWithPendingUpdates,
        tone: tone(hostsWithPendingUpdates, hostCount, "warn"),
      },
      {
        label: "Fully patched",
        value: hostsCleanPatches,
        tone: hostsCleanPatches === hostCount ? "good" : "neutral",
      },
      {
        label: "Unknown",
        value: hostsUnknownPatchStatus,
        tone: tone(hostsUnknownPatchStatus, hostCount, "warn"),
      },
      {
        label: "Total pending",
        value: totalPendingUpdates,
        tone: totalPendingUpdates > 0 ? "warn" : "good",
      },
    ],
    hostsWithPendingUpdates,
    hostsCleanPatches,
    hostsUnknownPatchStatus,
    totalPendingUpdates,
  };

  // Composite — weighted average of section scores, rounded.
  const composite = Math.round(
    vulnSection.score * COMPLIANCE_WEIGHTS.vulnerabilities +
      reportingSection.score * COMPLIANCE_WEIGHTS.reporting +
      postureSection.score * COMPLIANCE_WEIGHTS.posture +
      patchSection.score * COMPLIANCE_WEIGHTS.patches
  );

  return {
    scope: { hostCount, tagIds },
    generatedAt,
    composite: { score: composite, grade: gradeFor(composite) },
    sections: {
      vulnerabilities: vulnSection,
      reporting: reportingSection,
      posture: postureSection,
      patches: patchSection,
    },
  };
}
