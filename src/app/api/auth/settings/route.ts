import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET/PUT /api/auth/settings — per-user UI preferences (currently just
 * the display timezone). Lives under /api/auth/ because it's about the
 * logged-in user's own row; no admin gate required.
 */

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const row = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { timezone: true },
  });
  return NextResponse.json({ timezone: row?.timezone ?? null });
}

interface PutBody {
  timezone?: string | null;
}

/**
 * Validate that a string is a recognised IANA zone via the runtime
 * Intl.DateTimeFormat — same check the browser uses. Anything else
 * (typos, abandoned zones, garbage) gets rejected with a 400. Empty
 * string and null both mean "use browser default".
 */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function PUT(req: NextRequest) {
  const user = await getSession(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "malformed JSON" }, { status: 400 });
  }

  // Normalise: empty string and null both clear the field (revert to
  // browser default).
  let next: string | null;
  if (body.timezone === null || body.timezone === undefined) {
    next = null;
  } else if (typeof body.timezone !== "string") {
    return NextResponse.json(
      { error: "timezone must be a string or null" },
      { status: 400 }
    );
  } else {
    const trimmed = body.timezone.trim();
    if (trimmed.length === 0) {
      next = null;
    } else if (!isValidTimeZone(trimmed)) {
      return NextResponse.json(
        { error: `unknown timezone: ${trimmed}` },
        { status: 400 }
      );
    } else {
      next = trimmed;
    }
  }

  await prisma.user.update({
    where: { id: user.userId },
    data: { timezone: next },
  });

  return NextResponse.json({ timezone: next });
}
