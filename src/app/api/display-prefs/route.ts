import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getCollectorConfig, toDisplayPrefs } from "@/lib/collectorConfig";

/**
 * GET /api/display-prefs — cookie-authed read of the operator-facing UI
 * knobs that live on the CollectorConfig singleton (currently just the
 * host-staleness day thresholds).
 *
 * Any logged-in user can read this — the host list is non-admin and
 * needs the same dot colors as the admin sees. Writes still flow
 * through /api/admin/collector-config (admin only).
 *
 * Deliberately NOT reusing /api/v1/config: that endpoint is bearer-token
 * authed and uses the snake_case agent contract — wrong audience and
 * wrong shape for the UI.
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const row = await getCollectorConfig();
  return NextResponse.json(toDisplayPrefs(row));
}
