import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import { getCollectorConfig } from "@/lib/collectorConfig";
import { runCleanup } from "@/lib/cleanup";
import type { CleanupResult } from "@/lib/types";

/**
 * POST /api/admin/collector-config/cleanup — manually trigger a full
 * fleet-wide retention sweep. Awaited (unlike the ingest-path hook),
 * so the admin sees real counts in the response.
 *
 * Auth: admin JWT (cookie). Force-rotate gate still applies.
 */
export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const cfg = await getCollectorConfig();
  const result = await runCleanup(cfg, { force: true });

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "trigger",
    entityType: "collector_config",
    entityId: "default",
    summary: `manual cleanup (${result.reportsDeleted} reports, ${result.hostsDeleted} hosts deleted)`,
    diff: {
      before: null,
      after: {
        reportsDeleted: result.reportsDeleted,
        hostsDeleted: result.hostsDeleted,
        ranAt: result.ranAt.toISOString(),
      },
    },
  });

  const body: CleanupResult = {
    reportsDeleted: result.reportsDeleted,
    hostsDeleted: result.hostsDeleted,
    ranAt: result.ranAt.toISOString(),
  };
  return NextResponse.json(body);
}
