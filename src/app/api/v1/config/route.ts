import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractBearer, verifyIngestToken } from "@/lib/ingestToken";
import { getCollectorConfig, toPublicShape } from "@/lib/collectorConfig";
import { readScript } from "@/app/install/_lib/readScript";

/**
 * GET /api/v1/config — agent boot-time handshake.
 *
 * Auth: same bearer-token scheme as POST /api/v1/reports. The agent
 * calls this once per cron tick before assembling its payload; the
 * response tells it which inventory helpers to run.
 *
 * Wire shape:
 *   {
 *     "version":     <integer, bumped on every admin PUT that mutates>,
 *     "updated_at":  <ISO 8601 UTC>,
 *     "enabled": {
 *       "<feature_key>": true|false,
 *       …
 *     }
 *   }
 *
 * Feature keys are snake_case so the script can splice them straight
 * into its `read_bool_from_config()` lookups. The full key set is the
 * exported `AGENT_FEATURE_KEYS` array in `src/lib/types.ts`.
 *
 * Side effect: bumps `IngestToken.lastUsedAt` on success. A config
 * fetch is a real liveness signal — a healthy agent calls this every
 * run, even on cron ticks where the inventory diff is unchanged.
 *
 * Phase A round 2 — `agent` block added for collector-driven
 * self-update. The agent compares the script on disk against
 * `current_sha256`; mismatch triggers a download of `download_url` and
 * a hash-verified re-exec. See `agent/software-inventory.sh::self_update`.
 */

/**
 * 60-second cache of the agent script's sha256. Reads the same
 * `readScript("agent")` body the install endpoint serves so the hash
 * the agent compares against is the hash of exactly what it would
 * download. Cached because every authenticated agent in the fleet asks
 * for this on every cron tick.
 */
interface AgentHashEntry {
  hash: string;
  expiresAt: number;
}
let agentHashCache: AgentHashEntry | null = null;
const AGENT_HASH_TTL_MS = 60_000;

async function getAgentHash(): Promise<string | null> {
  const now = Date.now();
  if (agentHashCache && agentHashCache.expiresAt > now) {
    return agentHashCache.hash;
  }
  try {
    const body = await readScript("agent");
    const hash = createHash("sha256").update(body).digest("hex");
    agentHashCache = { hash, expiresAt: now + AGENT_HASH_TTL_MS };
    return hash;
  } catch (err) {
    // Don't hard-fail config delivery just because the script file is
    // missing — agents stay on the version they have. Log so the
    // operator can investigate.
    console.error(
      "config: failed to hash agent script",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
export async function GET(req: NextRequest) {
  const auth = extractBearer(req.headers.get("authorization"));
  if (!auth) {
    return NextResponse.json(
      { error: "missing bearer token" },
      { status: 401 }
    );
  }
  const verified = await verifyIngestToken(auth);
  if (!verified) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  const row = await getCollectorConfig();

  // Liveness signal. Match the pattern in POST /api/v1/reports — the
  // token row gets bumped outside any transaction since it's
  // non-critical and we don't want to take it down with us if it
  // fails.
  await prisma.ingestToken
    .update({
      where: { id: verified.token.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {
      // Best-effort. A bookkeeping failure must not block the agent
      // from getting its plan.
    });

  // Compose the response with the new `agent` self-update block. The
  // hash is best-effort — when the script can't be read we omit the
  // field entirely so the agent falls into its "older collector"
  // skip-silently branch instead of trying to verify against null.
  const base = toPublicShape(row);
  const hash = await getAgentHash();
  const body: typeof base & {
    agent?: { current_sha256: string; download_url: string };
  } = { ...base };
  if (hash) {
    body.agent = {
      current_sha256: hash,
      download_url: `${req.nextUrl.origin}/install/agent.sh`,
    };
  }
  return NextResponse.json(body);
}
