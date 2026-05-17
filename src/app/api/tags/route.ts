import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import type { TagSummary } from "@/lib/types";

/**
 * GET /api/tags — non-admin read of the tag taxonomy. Returns just
 * { id, name, color } so the host-list filter chips and any other
 * read-side surface can render without the admin's aggregate cost.
 *
 * `hostCount` is intentionally NOT included here — that aggregate is
 * an admin-only stat exposed via /api/admin/tags.
 *
 * Auth: any logged-in user. The host list is non-admin and needs the
 * same tag palette the admin sees.
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const rows = await prisma.tag.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });
  const body: TagSummary[] = rows;
  return NextResponse.json(body);
}
