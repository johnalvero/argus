import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Pull `timezone` fresh from the DB. We deliberately don't bake it
  // into the JWT — changing your display timezone shouldn't require a
  // token re-issue or interrupt other sessions.
  const row = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { timezone: true },
  });
  return NextResponse.json({
    id: user.userId,
    email: user.email,
    isAdmin: user.isAdmin,
    mustChangePassword: user.mustChangePassword,
    timezone: row?.timezone ?? null,
  });
}
