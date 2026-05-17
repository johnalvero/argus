import type { CollectorConfig } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Fleet-wide data retention sweep.
 *
 * Two operations, both gated on per-row retention config:
 *   1. Delete Reports older than `reportRetentionDays`. Single
 *      fleet-wide deleteMany — no per-host loop.
 *   2. If `inactiveHostRetentionDays` is set, delete Hosts whose
 *      `lastReportAt` is older than that cutoff. Their Reports and
 *      HostPackages cascade via FK (`onDelete: Cascade`).
 *
 * Updates `lastCleanupAt` on the singleton config when done so the
 * ingest path's auto-cleanup can throttle to once / 24h.
 *
 * Called from:
 *   • POST /api/v1/reports (fire-and-forget, throttled).
 *   • POST /api/admin/collector-config/cleanup (awaited, force=true).
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface RunCleanupResult {
  reportsDeleted: number;
  hostsDeleted: number;
  ranAt: Date;
}

export interface RunCleanupOptions {
  /**
   * Skip the once-per-24h throttle. The admin "Run cleanup now" button
   * uses this; the ingest hook does not.
   */
  force?: boolean;
}

/** True iff the auto-cleanup hook should fire on this ingest. */
export function shouldRunCleanup(cfg: CollectorConfig): boolean {
  if (!cfg.lastCleanupAt) return true;
  return Date.now() - cfg.lastCleanupAt.getTime() >= ONE_DAY_MS;
}

export async function runCleanup(
  cfg: CollectorConfig,
  opts: RunCleanupOptions = {}
): Promise<RunCleanupResult> {
  if (!opts.force && !shouldRunCleanup(cfg)) {
    // Throttled — caller should treat this as a no-op. Return zeros and
    // the existing timestamp so callers can render the UI consistently.
    return {
      reportsDeleted: 0,
      hostsDeleted: 0,
      ranAt: cfg.lastCleanupAt ?? new Date(),
    };
  }

  const now = new Date();

  // ── 1. Reports — fleet-wide deleteMany. ─────────────────────────────
  const reportCutoff = new Date(
    now.getTime() - cfg.reportRetentionDays * ONE_DAY_MS
  );
  const reports = await prisma.report.deleteMany({
    where: { receivedAt: { lt: reportCutoff } },
  });

  // ── 2. Hosts — only when retention is enabled. ──────────────────────
  let hostsDeleted = 0;
  if (cfg.inactiveHostRetentionDays != null) {
    const hostCutoff = new Date(
      now.getTime() - cfg.inactiveHostRetentionDays * ONE_DAY_MS
    );
    const hosts = await prisma.host.deleteMany({
      where: { lastReportAt: { lt: hostCutoff } },
    });
    hostsDeleted = hosts.count;
  }

  // Stamp the run so the throttle works. Don't bump `version` — agents
  // don't care about cleanup runs.
  await prisma.collectorConfig.update({
    where: { id: cfg.id },
    data: { lastCleanupAt: now },
  });

  return {
    reportsDeleted: reports.count,
    hostsDeleted,
    ranAt: now,
  };
}
