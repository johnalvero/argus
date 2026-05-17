import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auditLog";
import {
  ALLOWED_LOGO_MIME_TYPES,
  MAX_LOGO_BYTES,
  getBranding,
} from "@/lib/branding";

/**
 * POST /api/admin/branding/logo — upload a new logo.
 *
 * Multipart/form-data with one file field named `logo`. Server-side
 * validation:
 *   • MIME type in {image/png, image/jpeg, image/webp} — SVG is
 *     rejected (XSS risk via embedded scripts).
 *   • Size <= 500 KB.
 * On success, returns `{ ok: true, updatedAt }`. Validation failures
 * return 400 with a human-readable `error` message that the client
 * surfaces via toast.
 *
 * DELETE — clears the logo back to NULL. Sidebar falls back to the
 * Package icon.
 *
 * Auth: admin JWT (cookie). Force-rotate gate still applies.
 */

// Multipart overhead + worst-case base64 inflation makes 1 MB feel
// tight for a 500 KB logo. Give it a 2 MB ceiling pre-check; the
// stricter MAX_LOGO_BYTES check below still rejects anything past 500 KB.
const LOGO_REQUEST_MAX_BYTES = 2 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req, { maxBodyBytes: LOGO_REQUEST_MAX_BYTES });
  if (user instanceof NextResponse) return user;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "expected multipart/form-data" },
      { status: 400 }
    );
  }
  const file = form.get("logo");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "missing file field: logo" },
      { status: 400 }
    );
  }

  const mime = file.type;
  if (!ALLOWED_LOGO_MIME_TYPES.has(mime)) {
    return NextResponse.json(
      {
        error:
          "unsupported image type — only PNG, JPEG, and WEBP are allowed",
      },
      { status: 400 }
    );
  }
  if (file.size > MAX_LOGO_BYTES) {
    return NextResponse.json(
      { error: `logo too large (${file.size} bytes; max ${MAX_LOGO_BYTES})` },
      { status: 400 }
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "uploaded file is empty" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const current = await getBranding();
  const updated = await prisma.branding.update({
    where: { id: current.id },
    data: { logoData: buf, logoMimeType: mime },
  });

  const kb = Math.max(1, Math.round(file.size / 1024));
  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "upload",
    entityType: "branding",
    entityId: "default",
    summary: `uploaded logo (${kb} KB, ${mime})`,
    diff: {
      before: { mimeType: current.logoMimeType, hasLogo: current.logoData != null },
      after: { mimeType: mime, sizeBytes: file.size },
    },
  });

  return NextResponse.json({
    ok: true,
    updatedAt: updated.updatedAt.toISOString(),
  });
}

export async function DELETE(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const current = await getBranding();
  const updated = await prisma.branding.update({
    where: { id: current.id },
    data: { logoData: null, logoMimeType: null },
  });

  if (current.logoData != null) {
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "delete",
      entityType: "branding",
      entityId: "default",
      summary: "removed logo",
      diff: {
        before: { mimeType: current.logoMimeType, hasLogo: true },
        after: { hasLogo: false },
      },
    });
  }

  return NextResponse.json({
    ok: true,
    updatedAt: updated.updatedAt.toISOString(),
  });
}
