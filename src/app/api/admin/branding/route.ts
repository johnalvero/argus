import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auditLog";
import { getBranding, toBrandingPublic } from "@/lib/branding";

/**
 * PUT /api/admin/branding — update the org's display name.
 *
 * Body: `{ companyName: string }`. Trimmed, 1–80 chars, non-empty.
 * Returns the fresh public DTO on success. The logo binary is managed
 * via the sibling /logo route — there's no JSON pathway to set it.
 *
 * Auth: admin JWT (cookie). Force-rotate gate still applies.
 */
export async function PUT(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "body must be an object" },
      { status: 400 }
    );
  }
  const raw = (body as { companyName?: unknown }).companyName;
  if (typeof raw !== "string") {
    return NextResponse.json(
      { error: "companyName must be a string" },
      { status: 400 }
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    return NextResponse.json(
      { error: "companyName must be 1–80 characters after trimming" },
      { status: 400 }
    );
  }

  const current = await getBranding();
  const updated =
    current.companyName === trimmed
      ? current
      : await prisma.branding.update({
          where: { id: current.id },
          data: { companyName: trimmed },
        });

  if (current.companyName !== trimmed) {
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "update",
      entityType: "branding",
      entityId: "default",
      summary: `update branding (companyName: "${current.companyName}" → "${trimmed}")`,
      diff: {
        before: { companyName: current.companyName },
        after: { companyName: trimmed },
      },
    });
  }

  return NextResponse.json(toBrandingPublic(updated));
}
