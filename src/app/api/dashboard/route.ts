import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { computeCompliance } from "@/lib/compliance";
import { getCollectorConfig } from "@/lib/collectorConfig";
import { toSeverityBucket } from "@/lib/severity";
import type {
  CveSyncRunRow,
  DashboardActivity,
  DashboardResponse,
  DashboardTopHost,
  NotificationSeverity,
  TagSummary,
} from "@/lib/types";

/**
 * GET /api/dashboard — consolidated landing-page payload.
 *
 * Cookie-authed. Single round-trip; the home page is the most-hit
 * surface, so every source query is bounded (`take: 20` on the activity
 * streams; topHosts and counts are derived from already-bounded reads).
 *
 * Admin shape:  + audit + cve_sync activity items, + recentSyncs field.
 * Non-admin:    notifications only in the activity stream, no
 *               recentSyncs field at all (omitted, not nulled).
 */

const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const PER_SOURCE_LIMIT = 20;
const ACTIVITY_LIMIT = 20;
const TOP_HOSTS_LIMIT = 5;
const RECENT_SYNCS_LIMIT = 3;

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const now = Date.now();
  const windowStart = new Date(now - ACTIVITY_WINDOW_MS);
  const cfg = await getCollectorConfig();
  const amberMs = cfg.staleHostAmberDays * 86_400_000;
  const redMs = cfg.staleHostRedDays * 86_400_000;

  // Run independent reads in parallel — none of them depend on each
  // other. Compliance does its own queries internally.
  const [
    compliance,
    hosts,
    openCounts,
    newCritLast24h,
    totalNotifs,
    readForUser,
    sevRows,
    notifRows,
    recentSyncRows,
    auditRows,
  ] = await Promise.all([
    computeCompliance({ includeAdminDetail: user.isAdmin }),
    prisma.host.findMany({
      select: { id: true, hostname: true, lastReportAt: true },
    }),
    prisma.vulnerability.groupBy({
      by: ["severity"],
      where: {
        severity: { in: ["CRITICAL", "HIGH"] },
        hostVulns: { some: {} },
      },
      _count: { _all: true },
    }),
    // Count distinct CRITICAL vulnerabilities that newly affected at
    // least one host in the last 24h — keyed on
    // HostVulnerability.firstSeenAt, NOT Vulnerability.fetchedAt. A
    // re-sync that re-fetches an existing CVE bumps fetchedAt but
    // doesn't constitute "new on the fleet" — only a new HostVuln link
    // does. Avoids false-urgency on the dashboard.
    prisma.hostVulnerability
      .findMany({
        where: {
          firstSeenAt: { gte: windowStart },
          vulnerability: { severity: "CRITICAL" },
        },
        select: { vulnerabilityId: true },
        distinct: ["vulnerabilityId"],
      })
      .then((rows) => rows.length),
    // M4 scope: non-admins only see notifications from watchlists they
    // created. Mirror the same filter in both counts so the bell badge
    // matches what /notifications actually shows.
    prisma.notification.count({
      where: user.isAdmin
        ? {}
        : { watchlist: { createdById: user.userId } },
    }),
    prisma.notificationRead.count({
      where: {
        userId: user.userId,
        ...(user.isAdmin
          ? {}
          : { notification: { watchlist: { createdById: user.userId } } }),
      },
    }),
    // Per-host CRITICAL/HIGH counts for the top-hosts list. Same shape
    // as /api/hosts but scoped to the rows we need.
    prisma.hostVulnerability.findMany({
      where: {
        vulnerability: { severity: { in: ["CRITICAL", "HIGH"] } },
      },
      select: {
        hostId: true,
        vulnerabilityId: true,
        vulnerability: { select: { severity: true } },
      },
    }),
    // Activity: notifications in the last 24h. Bounded server-side via
    // take so a noisy fleet doesn't pull thousands of rows into memory.
    // Scoped to the caller's watchlists for non-admins (M4).
    prisma.notification.findMany({
      where: {
        createdAt: { gte: windowStart },
        ...(user.isAdmin
          ? {}
          : { watchlist: { createdById: user.userId } }),
      },
      orderBy: { createdAt: "desc" },
      take: PER_SOURCE_LIMIT,
      include: { watchlist: { select: { name: true } } },
    }),
    // Recent syncs — admin only; we still issue the query so the
    // activity stream below can include cve_sync items, but only spill
    // the rows to the response for admins.
    user.isAdmin
      ? prisma.cveSyncRun.findMany({
          orderBy: { startedAt: "desc" },
          take: Math.max(RECENT_SYNCS_LIMIT, PER_SOURCE_LIMIT),
          include: { triggeredBy: { select: { email: true } } },
        })
      : Promise.resolve([] as Array<never>),
    user.isAdmin
      ? prisma.auditEvent.findMany({
          where: { createdAt: { gte: windowStart } },
          orderBy: { createdAt: "desc" },
          take: PER_SOURCE_LIMIT,
        })
      : Promise.resolve([] as Array<never>),
  ]);

  // ─── Tags for the top-hosts payload ─────────────────────────────────
  // Issued after we know which hosts we'll surface, so the WHERE list
  // stays tight even on big fleets.
  // First compute the top-host candidate set so we only fetch tags for it.
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

  // ─── Host scope + staleness buckets ─────────────────────────────────
  let active = 0;
  let stale = 0;
  let dead = 0;
  const hostsById = new Map<
    number,
    { id: number; hostname: string; lastReportAt: Date }
  >();
  for (const h of hosts) {
    hostsById.set(h.id, h);
    const ageMs = now - h.lastReportAt.getTime();
    if (ageMs <= amberMs) active++;
    else if (ageMs <= redMs) stale++;
    else dead++;
  }

  // ─── Top hosts ──────────────────────────────────────────────────────
  // Only hosts with >= 1 CRITICAL or HIGH. Sort by (crit desc, high desc,
  // lastReportAt asc) — older report first within a tie so the operator
  // sees the longest-festering host first.
  const candidates: Array<{
    id: number;
    hostname: string;
    lastReportAt: Date;
    criticalCount: number;
    highCount: number;
  }> = [];
  for (const [hostId, sev] of sevByHost.entries()) {
    const host = hostsById.get(hostId);
    if (!host) continue;
    const criticalCount = sev.CRITICAL.size;
    const highCount = sev.HIGH.size;
    if (criticalCount === 0 && highCount === 0) continue;
    candidates.push({
      id: host.id,
      hostname: host.hostname,
      lastReportAt: host.lastReportAt,
      criticalCount,
      highCount,
    });
  }
  candidates.sort((a, b) => {
    if (a.criticalCount !== b.criticalCount) {
      return b.criticalCount - a.criticalCount;
    }
    if (a.highCount !== b.highCount) {
      return b.highCount - a.highCount;
    }
    return a.lastReportAt.getTime() - b.lastReportAt.getTime();
  });
  const topSlice = candidates.slice(0, TOP_HOSTS_LIMIT);

  // Fetch tags only for the surfaced hosts.
  const topHostTagsRows = topSlice.length
    ? await prisma.hostTag.findMany({
        where: { hostId: { in: topSlice.map((h) => h.id) } },
        include: { tag: true },
        orderBy: { tag: { name: "asc" } },
      })
    : [];
  const tagsByHost = new Map<number, TagSummary[]>();
  for (const ht of topHostTagsRows) {
    const list = tagsByHost.get(ht.hostId) ?? [];
    list.push({ id: ht.tag.id, name: ht.tag.name, color: ht.tag.color });
    tagsByHost.set(ht.hostId, list);
  }
  const topHosts: DashboardTopHost[] = topSlice.map((h) => ({
    id: h.id,
    hostname: h.hostname,
    lastReportAt: h.lastReportAt.toISOString(),
    criticalCount: h.criticalCount,
    highCount: h.highCount,
    tags: tagsByHost.get(h.id) ?? [],
  }));

  // ─── Open vulnerability summary ─────────────────────────────────────
  let openCritical = 0;
  let openHigh = 0;
  for (const row of openCounts) {
    if (row.severity === "CRITICAL") openCritical = row._count._all;
    else if (row.severity === "HIGH") openHigh = row._count._all;
  }

  // ─── Notifications (current user) ───────────────────────────────────
  const unreadCount = Math.max(0, totalNotifs - readForUser);

  // ─── Activity merge ─────────────────────────────────────────────────
  const activity: DashboardActivity[] = [];
  for (const n of notifRows) {
    activity.push({
      kind: "notification",
      at: n.createdAt.toISOString(),
      severity: n.severity as NotificationSeverity,
      title: n.title,
      href: n.href,
      watchlistName: n.watchlist?.name ?? "",
    });
  }
  if (user.isAdmin) {
    for (const a of auditRows) {
      activity.push({
        kind: "audit",
        at: a.createdAt.toISOString(),
        actorEmail: a.actorEmail,
        action: a.action,
        entityType: a.entityType,
        summary: a.summary,
      });
    }
    // cve_sync activity uses startedAt as the timestamp — that's when the
    // operator (or schedule) actually kicked it off.
    for (const s of recentSyncRows) {
      if (s.startedAt.getTime() < windowStart.getTime()) continue;
      activity.push({
        kind: "cve_sync",
        at: s.startedAt.toISOString(),
        status: s.status,
        vulnsDiscovered: s.vulnsDiscovered,
        newVulns: s.newVulns,
        hostsAffected: s.hostsAffected,
      });
    }
  }
  activity.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const trimmedActivity = activity.slice(0, ACTIVITY_LIMIT);

  // ─── Recent syncs (admin only — first N from the same fetch) ────────
  const recentSyncs: CveSyncRunRow[] = user.isAdmin
    ? recentSyncRows.slice(0, RECENT_SYNCS_LIMIT).map((r) => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
        status: r.status as CveSyncRunRow["status"],
        packagesQueried: r.packagesQueried,
        vulnsDiscovered: r.vulnsDiscovered,
        hostsAffected: r.hostsAffected,
        newVulns: r.newVulns,
        error: r.error,
        triggeredByEmail: r.triggeredBy?.email ?? null,
      }))
    : [];

  const body: DashboardResponse = {
    scope: { hostCount: hosts.length },
    compliance: {
      score: compliance.composite.score,
      grade: compliance.composite.grade,
    },
    hosts: {
      total: hosts.length,
      active,
      stale,
      dead,
    },
    vulnerabilities: {
      openCritical,
      openHigh,
      newCriticalLast24h: newCritLast24h,
    },
    notifications: { unreadCount },
    topHosts,
    activity: trimmedActivity,
    ...(user.isAdmin ? { recentSyncs } : {}),
  };

  return NextResponse.json(body);
}
