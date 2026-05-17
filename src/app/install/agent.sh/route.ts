import { NextResponse } from "next/server";
import { readScript } from "../_lib/readScript";

/**
 * GET /install/agent.sh — streams the inventory agent script verbatim.
 *
 * No auth: the script itself carries no secrets. The bearer token is
 * provided to the agent out-of-band via /etc/inventory-agent/env. This
 * mirrors how `get.docker.com` and `sh.rustup.rs` serve their installers.
 */
export async function GET() {
  try {
    const body = await readScript("agent");
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "read failed";
    return new NextResponse(`# agent.sh unavailable: ${msg}\nexit 1\n`, {
      status: 500,
      headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
    });
  }
}
