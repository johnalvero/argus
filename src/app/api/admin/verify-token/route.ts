import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { verifyIngestToken } from "@/lib/ingestToken";

interface Body {
  token?: string;
}

/**
 * POST /api/admin/verify-token — admin-gated test endpoint for the
 * Install page. Takes a raw ingest token in the body, runs it through
 * the same verifier the ingest path uses, and returns a small shape
 * the UI can render: { valid, tokenName? }.
 *
 * On failure we deliberately do NOT leak which prefix did/didn't match;
 * the client just sees `{ valid: false }`.
 */
export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const raw = (body.token ?? "").trim();
  if (!raw) {
    return NextResponse.json(
      { error: "body.token (string) required" },
      { status: 400 }
    );
  }

  const result = await verifyIngestToken(raw);
  if (!result) {
    return NextResponse.json({ valid: false });
  }
  return NextResponse.json({
    valid: true,
    tokenName: result.token.name,
  });
}
