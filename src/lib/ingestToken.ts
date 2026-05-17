import bcrypt from "bcrypt";
import crypto from "crypto";
import type { IngestToken } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Ingest tokens are bearer credentials carried by `software-inventory.sh`
 * agents. They are NOT JWTs — they're random 32-byte values prefixed
 * with `argus_`.
 *
 * Storage: only the bcrypt hash. The raw token is returned exactly once
 * at creation time and is irrecoverable thereafter.
 *
 * Lookup pattern: the first 8 chars of the raw value (prefix) are
 * stored verbatim and indexed. On every request we narrow by prefix
 * (fast), then `bcrypt.compare` against the hash (slow but bounded —
 * at most one comparison per prefix in 99% of cases, since prefixes
 * have ~16M of entropy).
 *
 * Legacy: tokens minted before the SBOM→Argus rename use the `sbom_`
 * prefix. Verification accepts both; generation only emits `argus_`.
 */

const NEW_TOKEN_PREFIX_LITERAL = "argus_";
const ACCEPTED_TOKEN_PREFIXES = ["argus_", "sbom_"] as const;
const RAW_TOKEN_HEX_BYTES = 32;
const PREFIX_LEN = 8;
const BCRYPT_ROUNDS = 12;

export interface GeneratedToken {
  raw: string;
  hash: string;
  prefix: string;
}

/**
 * Generate a fresh raw token + its bcrypt hash + the prefix to store.
 * Only ever called from POST /api/admin/tokens — the raw value never
 * leaves that request boundary except in the JSON response.
 */
export async function generateIngestToken(): Promise<GeneratedToken> {
  const raw =
    NEW_TOKEN_PREFIX_LITERAL +
    crypto.randomBytes(RAW_TOKEN_HEX_BYTES).toString("hex");
  const prefix = raw.slice(0, PREFIX_LEN);
  const hash = await bcrypt.hash(raw, BCRYPT_ROUNDS);
  return { raw, hash, prefix };
}

export interface VerifiedIngestToken {
  token: IngestToken;
}

/**
 * Verify a bearer header value against the IngestToken table. Returns
 * the row if valid + enabled, null otherwise. Constant-ish time inside
 * a single prefix; cross-prefix timing leakage is not a meaningful
 * threat for an internal collector.
 *
 * Caller is responsible for updating `lastUsedAt` after successful
 * ingest — we don't do it here so a verify-but-no-ingest path doesn't
 * pollute the audit field.
 */
export async function verifyIngestToken(
  rawHeaderValue: string
): Promise<VerifiedIngestToken | null> {
  if (
    !ACCEPTED_TOKEN_PREFIXES.some((p) => rawHeaderValue.startsWith(p)) ||
    rawHeaderValue.length < PREFIX_LEN + 4
  ) {
    return null;
  }
  const prefix = rawHeaderValue.slice(0, PREFIX_LEN);

  // Prefix uniqueness is not enforced at the DB level (two tokens
  // could collide on the first 8 chars), so we iterate. In practice
  // this is 1 row almost always.
  const candidates = await prisma.ingestToken.findMany({
    where: { prefix, enabled: true },
  });

  for (const candidate of candidates) {
    const ok = await bcrypt.compare(rawHeaderValue, candidate.tokenHash);
    if (ok) return { token: candidate };
  }
  return null;
}

export function extractBearer(
  header: string | null | undefined
): string | null {
  if (!header) return null;
  if (!header.startsWith("Bearer ")) return null;
  const raw = header.slice("Bearer ".length).trim();
  return raw || null;
}
