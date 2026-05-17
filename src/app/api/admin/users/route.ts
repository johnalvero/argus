import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  checkLoginRateLimit,
  extractClientIp,
  hashPassword,
  requireAdmin,
} from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";

/**
 * GET  /api/admin/users — list every UI user.
 * POST                  — create a UI user. Admin sets the initial
 *                         password; the row is created with
 *                         mustChangePassword=1 so the target must
 *                         rotate on first login.
 */
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const rows = await prisma.user.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      email: true,
      isAdmin: true,
      mustChangePassword: true,
      createdAt: true,
    },
  });
  return NextResponse.json(
    rows.map((u) => ({
      id: u.id,
      email: u.email,
      isAdmin: u.isAdmin,
      mustChangePassword: u.mustChangePassword,
      createdAt: u.createdAt.toISOString(),
    }))
  );
}

interface PostBody {
  email?: string;
  password?: string;
  isAdmin?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const ip = extractClientIp(req);
  const rl = checkLoginRateLimit(ip);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "valid email required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "password must be at least 8 characters" },
      { status: 400 }
    );
  }
  const isAdmin = body.isAdmin === true;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "email already in use" },
      { status: 409 }
    );
  }

  const passwordHash = await hashPassword(password);
  const created = await prisma.user.create({
    data: {
      email,
      passwordHash,
      isAdmin,
      mustChangePassword: true,
    },
    select: {
      id: true,
      email: true,
      isAdmin: true,
      mustChangePassword: true,
      createdAt: true,
    },
  });

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "create",
    entityType: "user",
    entityId: String(created.id),
    summary: `create user "${created.email}"${created.isAdmin ? " (admin)" : ""}`,
    diff: {
      before: null,
      after: { email: created.email, isAdmin: created.isAdmin },
    },
  });

  return NextResponse.json(
    {
      id: created.id,
      email: created.email,
      isAdmin: created.isAdmin,
      mustChangePassword: created.mustChangePassword,
      createdAt: created.createdAt.toISOString(),
    },
    { status: 201 }
  );
}
