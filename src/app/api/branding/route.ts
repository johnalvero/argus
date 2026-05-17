import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getBranding, toBrandingPublic } from "@/lib/branding";

/**
 * GET /api/branding — cookie-authed read of the branding singleton.
 *
 * Returns the public DTO only (companyName + hasLogo + updatedAt). The
 * logo binary is fetched separately from /api/branding/logo so the
 * browser caches it on its own ETag. `updatedAt` doubles as the
 * cache-buster the client appends to the logo <img src>.
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const row = await getBranding();
  return NextResponse.json(toBrandingPublic(row));
}
