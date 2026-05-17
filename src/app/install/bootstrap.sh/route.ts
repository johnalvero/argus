import { NextResponse } from "next/server";
import { readScript } from "../_lib/readScript";

/**
 * GET /install/bootstrap.sh — streams the one-shot installer.
 * Same caching/no-auth model as /install/agent.sh.
 */
export async function GET() {
  try {
    const body = await readScript("bootstrap");
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "read failed";
    return new NextResponse(
      `# bootstrap.sh unavailable: ${msg}\nexit 1\n`,
      {
        status: 500,
        headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
      }
    );
  }
}
