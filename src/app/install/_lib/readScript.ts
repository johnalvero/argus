import { readFile } from "fs/promises";
import path from "path";

/**
 * Read one of the two installer scripts off disk, with a 60-second
 * in-memory cache so repeat hits don't pound the FS. Single-process
 * Next.js — no need for anything fancier.
 *
 * Paths are configurable via env so deploys that copy the scripts into
 * a different relative location (e.g. Docker images) can point us at
 * them without code changes.
 */

type Kind = "agent" | "bootstrap";

interface CacheEntry {
  body: string;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache: Map<Kind, CacheEntry> = new Map();

function resolvePath(kind: Kind): string {
  const fromEnv =
    kind === "agent"
      ? process.env.AGENT_SCRIPT_PATH
      : process.env.AGENT_BOOTSTRAP_PATH;
  const fallback =
    kind === "agent"
      ? "agent/software-inventory.sh"
      : "agent/bootstrap-inventory-agent.sh";
  return path.resolve(process.cwd(), fromEnv ?? fallback);
}

export async function readScript(kind: Kind): Promise<string> {
  const now = Date.now();
  const hit = cache.get(kind);
  if (hit && hit.expiresAt > now) return hit.body;

  const filePath = resolvePath(kind);
  let body: string;
  try {
    body = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `script not found at ${filePath} — set ${
          kind === "agent" ? "AGENT_SCRIPT_PATH" : "AGENT_BOOTSTRAP_PATH"
        } or place the file there`
      );
    }
    throw err;
  }

  cache.set(kind, { body, expiresAt: now + TTL_MS });
  return body;
}
