import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import type { TagSummary } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PutBody {
  tagIds?: unknown;
}

/**
 * PUT /api/admin/hosts/[id]/tags — replace the set of tags on a host.
 *
 * Body: { tagIds: number[] }.
 *
 * Replace-semantics: we wipe every existing HostTag for this host and
 * re-insert. Idempotent — calling twice with the same set is a no-op
 * (modulo updated timestamps on the join rows).
 *
 * Validation:
 *   • body.tagIds must be an array of positive integers.
 *   • Every id must reference an existing Tag — partial validity is
 *     rejected (we don't want a typo to silently strip the rest).
 *   • Duplicates in the input are tolerated and de-duped server-side.
 *
 * Returns the updated tag list (TagSummary[]) so the client can swap
 * its local copy without a follow-up GET.
 *
 * Audit hook (Phase A round 2): drop `await auditLog(...)` after the
 * transaction succeeds with the {hostId, added, removed} diff.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const hostId = Number(id);
  if (!Number.isFinite(hostId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!Array.isArray(body.tagIds)) {
    return NextResponse.json(
      { error: "tagIds must be an array of tag ids" },
      { status: 400 }
    );
  }
  const tagIds: number[] = [];
  for (const raw of body.tagIds) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      return NextResponse.json(
        { error: "tagIds must contain only positive integers" },
        { status: 400 }
      );
    }
    tagIds.push(raw);
  }
  // De-dup. Preserves the first occurrence; replace-semantics doesn't
  // care about order.
  const uniqueTagIds = Array.from(new Set(tagIds));

  // Cheap up-front existence checks. Host first — clearer 404. Then
  // tags, so a partial typo turns into a clean 400 rather than a half-
  // applied write.
  const host = await prisma.host.findUnique({
    where: { id: hostId },
    select: { id: true, hostname: true },
  });
  if (!host) {
    return NextResponse.json({ error: "host not found" }, { status: 404 });
  }
  if (uniqueTagIds.length > 0) {
    const found = await prisma.tag.findMany({
      where: { id: { in: uniqueTagIds } },
      select: { id: true },
    });
    if (found.length !== uniqueTagIds.length) {
      const foundSet = new Set(found.map((t) => t.id));
      const missing = uniqueTagIds.filter((id) => !foundSet.has(id));
      return NextResponse.json(
        { error: `unknown tag id(s): ${missing.join(", ")}` },
        { status: 400 }
      );
    }
  }

  // Snapshot the current set so the audit row can show added/removed.
  const previous = await prisma.hostTag.findMany({
    where: { hostId },
    include: { tag: { select: { id: true, name: true } } },
  });

  // Replace-semantics in a transaction so a partial write can never
  // strip tags without re-adding the new set.
  await prisma.$transaction([
    prisma.hostTag.deleteMany({ where: { hostId } }),
    ...(uniqueTagIds.length > 0
      ? [
          prisma.hostTag.createMany({
            data: uniqueTagIds.map((tagId) => ({ hostId, tagId })),
          }),
        ]
      : []),
  ]);

  // Re-read for the response — guarantees the client sees exactly the
  // same shape it would from a fresh GET. Ordered alphabetically to
  // match the read endpoints.
  const refreshed = await prisma.hostTag.findMany({
    where: { hostId },
    include: { tag: true },
    orderBy: { tag: { name: "asc" } },
  });

  const previousIds = new Set(previous.map((p) => p.tag.id));
  const nextIds = new Set(uniqueTagIds);
  const addedNames = refreshed
    .filter((ht) => !previousIds.has(ht.tag.id))
    .map((ht) => ht.tag.name);
  const removedNames = previous
    .filter((p) => !nextIds.has(p.tag.id))
    .map((p) => p.tag.name);

  if (addedNames.length > 0 || removedNames.length > 0) {
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "update",
      entityType: "host_tag",
      entityId: String(hostId),
      summary: `replaced tags on host "${host.hostname}" — added [${addedNames.join(
        ","
      )}], removed [${removedNames.join(",")}]`,
      diff: {
        before: previous.map((p) => ({ id: p.tag.id, name: p.tag.name })),
        after: refreshed.map((r) => ({ id: r.tag.id, name: r.tag.name })),
      },
    });
  }

  const out: TagSummary[] = refreshed.map((ht) => ({
    id: ht.tag.id,
    name: ht.tag.name,
    color: ht.tag.color,
  }));
  return NextResponse.json(out);
}
