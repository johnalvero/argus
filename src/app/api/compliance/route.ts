import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { computeCompliance } from "@/lib/compliance";

/**
 * GET /api/compliance — fleet-wide compliance scorecard.
 *
 * Cookie-authed (any logged-in user). All scoring logic lives in
 * `src/lib/compliance.ts` so the dashboard endpoint can reuse it
 * verbatim — this route is just shape-of-request → shape-of-response
 * glue.
 */

function parseTagIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim().replace(/[^0-9]/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const tagIds = parseTagIds(url.searchParams.get("tag"));
  const body = await computeCompliance({
    tagIds,
    includeAdminDetail: user.isAdmin,
  });
  return NextResponse.json(body);
}
