import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import {
  normalizeTagColor,
  normalizeTagDescription,
  normalizeTagName,
} from "@/lib/tags";
import type { TagAdmin } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  name?: unknown;
  color?: unknown;
  description?: unknown;
}

/**
 * PATCH  /api/admin/tags/[id] — partial update. Any subset of
 *                               name/color/description. Renames are
 *                               allowed; we don't slug-freeze the name.
 * DELETE                       — cascades through HostTag. Returns the
 *                               removed-association count so the toast
 *                               can confirm impact.
 *
 * Audit hook (Phase A round 2): drop `await auditLog(...)` after each
 * successful mutation.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const tagId = Number(id);
  if (!Number.isFinite(tagId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Build a partial update — only fields that were actually present in
  // the body are touched. Unknown keys are silently ignored (tracking
  // them as 400s here adds noise for forwards-compatibility).
  const data: { name?: string; color?: string; description?: string | null } = {};
  if ("name" in body) {
    const r = normalizeTagName(body.name);
    if (!r.ok) {
      return NextResponse.json({ error: r.error.message }, { status: 400 });
    }
    data.name = r.value;
  }
  if ("color" in body) {
    const r = normalizeTagColor(body.color);
    if (!r.ok) {
      return NextResponse.json({ error: r.error.message }, { status: 400 });
    }
    data.color = r.value;
  }
  if ("description" in body) {
    const r = normalizeTagDescription(body.description);
    if (!r.ok) {
      return NextResponse.json({ error: r.error.message }, { status: 400 });
    }
    data.description = r.value;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "no recognised fields to update" },
      { status: 400 }
    );
  }

  // Snapshot for the audit diff. Skipped if we can't even find the
  // row — the update below will 404 instead.
  const before = await prisma.tag.findUnique({ where: { id: tagId } });

  try {
    const updated = await prisma.tag.update({
      where: { id: tagId },
      data,
      include: { _count: { select: { hosts: true } } },
    });
    if (before) {
      const changes: string[] = [];
      const diffBefore: Record<string, unknown> = {};
      const diffAfter: Record<string, unknown> = {};
      for (const key of ["name", "color", "description"] as const) {
        if (key in data && before[key] !== updated[key]) {
          changes.push(
            `${key} ${JSON.stringify(before[key])} → ${JSON.stringify(updated[key])}`
          );
          diffBefore[key] = before[key];
          diffAfter[key] = updated[key];
        }
      }
      auditLog(req, {
        actorId: user.userId,
        actorEmail: user.email,
        action: "update",
        entityType: "tag",
        entityId: String(updated.id),
        summary:
          changes.length > 0
            ? `update tag "${updated.name}" (${changes.join(", ")})`
            : `update tag "${updated.name}" (no-op)`,
        diff: { before: diffBefore, after: diffAfter },
      });
    }
    const out: TagAdmin = {
      id: updated.id,
      name: updated.name,
      color: updated.color,
      description: updated.description,
      hostCount: updated._count.hosts,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2025") {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      if (err.code === "P2002") {
        return NextResponse.json(
          { error: `tag "${data.name}" already exists` },
          { status: 409 }
        );
      }
    }
    throw err;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const tagId = Number(id);
  if (!Number.isFinite(tagId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  // Count associations BEFORE the cascade so the toast can confirm
  // impact. SQLite handles the actual row removal via the FK ON DELETE
  // CASCADE — we don't enumerate join rows ourselves.
  const existing = await prisma.tag.findUnique({
    where: { id: tagId },
    include: { _count: { select: { hosts: true } } },
  });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const removedAssociations = existing._count.hosts;

  await prisma.tag.delete({ where: { id: tagId } });

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "delete",
    entityType: "tag",
    entityId: String(tagId),
    summary: `delete tag "${existing.name}" (${removedAssociations} host${
      removedAssociations === 1 ? "" : "s"
    } unlinked)`,
    diff: {
      before: {
        name: existing.name,
        color: existing.color,
        description: existing.description,
        hostCount: removedAssociations,
      },
      after: null,
    },
  });

  return NextResponse.json({ ok: true, removedAssociations });
}
