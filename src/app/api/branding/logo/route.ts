import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getBranding } from "@/lib/branding";

/**
 * GET /api/branding/logo — cookie-authed, returns the raw logo bytes
 * with the stored Content-Type.
 *
 * Caching strategy: per-user (private), revalidate-on-every-request,
 * with an ETag derived from updatedAt. Browsers send If-None-Match on
 * the next request and we return 304 when the row hasn't changed —
 * tiny round-trip, no body. The <img src> cache-buster
 * (?v={updatedAt}) handles the immediate post-upload refetch.
 *
 * Returns 404 when no logo is set so the client can fall back to the
 * default Package icon without a noisy error.
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const row = await getBranding();
  if (!row.logoData || !row.logoMimeType) {
    return NextResponse.json({ error: "no_logo" }, { status: 404 });
  }

  // Quote ETag value per RFC 7232. updatedAt millis are sufficient —
  // the row only mutates via the admin PUT/POST/DELETE handlers.
  const etag = `"branding-${row.updatedAt.getTime()}"`;
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  }

  // Prisma returns Bytes as a Node Buffer. Pass through directly; the
  // response stream accepts a BodyInit-compatible Uint8Array.
  const bytes = row.logoData as unknown as Buffer;
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": row.logoMimeType,
      "Content-Length": String(bytes.length),
      ETag: etag,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
