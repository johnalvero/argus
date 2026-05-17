import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import { generateIngestToken } from "@/lib/ingestToken";

/**
 * GET /api/admin/tokens — list ingest tokens (without the raw value).
 * POST                  — create a new token. RETURNS the raw value
 *                         exactly once in the response; never persisted.
 */
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const rows = await prisma.ingestToken.findMany({
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { email: true } } },
  });
  return NextResponse.json(
    rows.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      createdAt: t.createdAt.toISOString(),
      createdByEmail: t.createdBy?.email ?? "—",
      lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
      enabled: t.enabled,
    }))
  );
}

interface PostBody {
  name?: string;
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

  const name = body.name?.trim() ?? "";
  if (!name || name.length > 64) {
    return NextResponse.json(
      { error: "name is required (1-64 chars)" },
      { status: 400 }
    );
  }

  const { raw, hash, prefix } = await generateIngestToken();

  const created = await prisma.ingestToken.create({
    data: {
      name,
      tokenHash: hash,
      prefix,
      createdById: user.userId,
    },
  });

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "create",
    entityType: "ingest_token",
    entityId: String(created.id),
    summary: `create ingest token "${created.name}" (prefix ${created.prefix})`,
    diff: {
      before: null,
      after: { name: created.name, prefix: created.prefix, enabled: true },
    },
  });

  // Raw token returned EXACTLY ONCE. Operator must copy it now.
  return NextResponse.json(
    {
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      createdAt: created.createdAt.toISOString(),
      enabled: created.enabled,
      token: raw,
    },
    { status: 201 }
  );
}
