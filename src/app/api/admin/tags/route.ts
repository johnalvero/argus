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

/**
 * GET  /api/admin/tags — list every tag with its host-count aggregate,
 *                        sorted alphabetically. Admin-only.
 * POST                 — create a tag. Body: { name, color, description? }.
 *
 * Audit hook (Phase A round 2): drop `await auditLog(...)` after the
 * successful create.
 */
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const rows = await prisma.tag.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { hosts: true } } },
  });

  const body: TagAdmin[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    description: t.description,
    hostCount: t._count.hosts,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));
  return NextResponse.json(body);
}

interface PostBody {
  name?: unknown;
  color?: unknown;
  description?: unknown;
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = normalizeTagName(body.name);
  if (!name.ok) {
    return NextResponse.json({ error: name.error.message }, { status: 400 });
  }
  const color = normalizeTagColor(body.color);
  if (!color.ok) {
    return NextResponse.json({ error: color.error.message }, { status: 400 });
  }
  const description = normalizeTagDescription(body.description);
  if (!description.ok) {
    return NextResponse.json(
      { error: description.error.message },
      { status: 400 }
    );
  }

  try {
    const created = await prisma.tag.create({
      data: {
        name: name.value,
        color: color.value,
        description: description.value,
      },
    });
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "create",
      entityType: "tag",
      entityId: String(created.id),
      summary: `create tag "${created.name}" (${created.color})`,
      diff: {
        before: null,
        after: {
          name: created.name,
          color: created.color,
          description: created.description,
        },
      },
    });
    // Fresh row → hostCount is always 0; no need for a follow-up query.
    const out: TagAdmin = {
      id: created.id,
      name: created.name,
      color: created.color,
      description: created.description,
      hostCount: 0,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    // P2002 = unique constraint violation. Distinguish duplicates from
    // generic 500s so the UI can surface a clear "name already exists".
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { error: `tag "${name.value}" already exists` },
        { status: 409 }
      );
    }
    throw err;
  }
}
