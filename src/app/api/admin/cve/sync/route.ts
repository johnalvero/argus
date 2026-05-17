import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import { CveSyncAlreadyRunningError, runCveSync } from "@/lib/cveSync";
import type { CveSyncRunRow } from "@/lib/types";

/**
 * POST /api/admin/cve/sync — kick off a CVE sync run.
 *   Inserts a CveSyncRun row in "running" state and fires the worker
 *   on the event loop. Returns immediately with { runId } so the
 *   header polling loop can take over.
 *
 * GET /api/admin/cve/sync — last 20 sync runs, newest first. Polled
 *   by the header at 3s while a run is in progress.
 *
 * Auth: admin JWT (cookie). Force-rotate gate still applies.
 */

const LIST_LIMIT = 20;

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  let runId: number;
  try {
    ({ runId } = await runCveSync(user.userId));
  } catch (err) {
    if (err instanceof CveSyncAlreadyRunningError) {
      return NextResponse.json(
        { error: "sync already running", runId: err.runId },
        { status: 409 }
      );
    }
    throw err;
  }

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "trigger",
    entityType: "cve_sync",
    entityId: String(runId),
    summary: `triggered CVE sync (run #${runId})`,
  });

  return NextResponse.json({ runId }, { status: 202 });
}

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const rows = await prisma.cveSyncRun.findMany({
    orderBy: { startedAt: "desc" },
    take: LIST_LIMIT,
    include: { triggeredBy: { select: { email: true } } },
  });

  const body: CveSyncRunRow[] = rows.map((r) => ({
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
  }));
  return NextResponse.json(body);
}
