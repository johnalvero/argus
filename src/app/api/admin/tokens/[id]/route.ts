import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  enabled?: boolean;
}

/**
 * PATCH /api/admin/tokens/[id] — flip the enabled bit. We don't expose
 * any other mutation paths; rotating a token = revoke + create new.
 *
 * DELETE — hard remove. Past reports keep their relationship to Host;
 * the audit trail "this token shipped that report" isn't tracked
 * server-side beyond `lastUsedAt`, so deletion is safe.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const tokenId = Number(id);
  if (!Number.isFinite(tokenId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "body.enabled (boolean) required" },
      { status: 400 }
    );
  }

  const existing = await prisma.ingestToken.findUnique({
    where: { id: tokenId },
  });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const updated = await prisma.ingestToken.update({
    where: { id: tokenId },
    data: { enabled: body.enabled },
  });

  if (existing.enabled !== updated.enabled) {
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "update",
      entityType: "ingest_token",
      entityId: String(updated.id),
      summary: `${updated.enabled ? "enable" : "disable"} ingest token "${existing.name}" (prefix ${existing.prefix})`,
      diff: {
        before: { enabled: existing.enabled },
        after: { enabled: updated.enabled },
      },
    });
  }

  return NextResponse.json({ id: updated.id, enabled: updated.enabled });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const tokenId = Number(id);
  if (!Number.isFinite(tokenId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const existing = await prisma.ingestToken.findUnique({
    where: { id: tokenId },
  });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await prisma.ingestToken.delete({ where: { id: tokenId } });

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "delete",
    entityType: "ingest_token",
    entityId: String(tokenId),
    summary: `delete ingest token "${existing.name}" (prefix ${existing.prefix})`,
    diff: {
      before: {
        name: existing.name,
        prefix: existing.prefix,
        enabled: existing.enabled,
      },
      after: null,
    },
  });

  return NextResponse.json({ ok: true });
}
