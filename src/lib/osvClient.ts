/**
 * Minimal client for osv.dev — the free, no-auth vulnerability database.
 *
 * Two endpoints in play:
 *   • POST /v1/querybatch  — bulk "which vulns affect (pkg, version)?"
 *                            lookup. Max 1000 queries per call. Returns
 *                            an aligned array of `{ vulns: [{id, modified}] }`,
 *                            ids only — no detail.
 *   • GET  /v1/vulns/{id}  — full vulnerability record.
 *
 * Rate limits are generous in practice but we still pace ourselves:
 * sequential batches + a 100ms inter-request pause so we stay a friendly
 * neighbour. Single retry with 2s backoff on 5xx; 4xx fails fast.
 *
 * The OSV vuln shape is intentionally loose. We type only what we
 * actually consume (severity vector, references, modified) and treat the
 * rest as opaque.
 */

const OSV_BASE = "https://api.osv.dev";
const USER_AGENT = "Argus/1.0 (security@convergeict.com)";
const INTER_REQUEST_PAUSE_MS = 100;
const RETRY_DELAY_MS = 2000;
const BATCH_SIZE = 1000;

// ─── Public shapes ─────────────────────────────────────────────────────

export interface OsvBatchQuery {
  package: { name: string; ecosystem: string };
  version: string;
}

export interface OsvBatchHit {
  id: string;
  modified: string;
}

export interface OsvBatchResult {
  vulns: OsvBatchHit[];
}

export interface OsvSeverityEntry {
  type: string; // "CVSS_V2" | "CVSS_V3" | "CVSS_V4" | ...
  score: string; // CVSS vector string
}

export interface OsvReferenceEntry {
  type: string; // "ADVISORY" | "WEB" | "FIX" | "REPORT" | ...
  url: string;
}

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  modified?: string;
  published?: string;
  severity?: OsvSeverityEntry[];
  references?: OsvReferenceEntry[];
  // Anything else (affected, database_specific, ...) we keep untyped —
  // we don't store it.
  [k: string]: unknown;
}

// ─── Ecosystem mapping ─────────────────────────────────────────────────
// HostPackage.ecosystem -> OSV ecosystem name. For "os" we further key
// off Host.osId because OSV partitions OS vulns per distro.

const LANG_ECOSYSTEMS: Record<string, string> = {
  pip: "PyPI",
  npm: "npm",
  gem: "RubyGems",
  composer: "Packagist",
  cargo: "crates.io",
};

// Best-effort osId -> OSV distro ecosystem. Anything not listed maps to
// null and the caller drops the row + logs once.
const OS_ECOSYSTEMS: Record<string, string> = {
  ubuntu: "Ubuntu",
  debian: "Debian",
  alpine: "Alpine",
  rocky: "Rocky Linux",
  // OSV doesn't break out CentOS / Amazon Linux separately at the level
  // we care about; the closest published feed is Red Hat. Best-effort —
  // false negatives are acceptable here, false positives would be worse.
  rhel: "Red Hat",
  centos: "Red Hat",
  amzn: "Red Hat",
  arch: "Arch Linux",
  suse: "SUSE",
  "opensuse-leap": "openSUSE",
  "opensuse-tumbleweed": "openSUSE",
};

export function toOsvEcosystem(
  ecosystem: string,
  osId?: string | null
): string | null {
  if (ecosystem === "os") {
    if (!osId) return null;
    const direct = OS_ECOSYSTEMS[osId];
    if (direct) return direct;
    // Loose match for opensuse-* tags we haven't enumerated.
    if (osId.startsWith("opensuse")) return "openSUSE";
    return null;
  }
  // snap / flatpak / anything unmapped is intentionally null — OSV has
  // no ecosystem feed for those.
  return LANG_ECOSYSTEMS[ecosystem] ?? null;
}

// ─── CVSS parsing ──────────────────────────────────────────────────────

/**
 * Extract the base score from a CVSS v3.x vector string. OSV stores the
 * vector verbatim (e.g. `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`)
 * and *not* the precomputed numeric score, so we reproduce the v3.1 base
 * formula here.
 *
 * Returns null when the vector is malformed or required metrics are
 * missing — better to surface "UNKNOWN" than fabricate a score.
 */
export function parseCvssV3Score(vector: string): number | null {
  if (!vector.startsWith("CVSS:3")) return null;

  const metrics: Record<string, string> = {};
  for (const part of vector.split("/")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    metrics[part.slice(0, idx)] = part.slice(idx + 1);
  }

  // AV / AC / UI / S — exploitability + scope.
  const AV: Record<string, number> = {
    N: 0.85,
    A: 0.62,
    L: 0.55,
    P: 0.2,
  };
  const AC: Record<string, number> = { L: 0.77, H: 0.44 };
  const UI: Record<string, number> = { N: 0.85, R: 0.62 };
  // PR depends on scope; unchanged vs changed.
  const PR_UNCHANGED: Record<string, number> = {
    N: 0.85,
    L: 0.62,
    H: 0.27,
  };
  const PR_CHANGED: Record<string, number> = {
    N: 0.85,
    L: 0.68,
    H: 0.5,
  };
  const CIA: Record<string, number> = { N: 0, L: 0.22, H: 0.56 };

  const av = AV[metrics.AV ?? ""];
  const ac = AC[metrics.AC ?? ""];
  const ui = UI[metrics.UI ?? ""];
  const scope = metrics.S; // "U" | "C"
  const pr = scope === "C"
    ? PR_CHANGED[metrics.PR ?? ""]
    : PR_UNCHANGED[metrics.PR ?? ""];
  const c = CIA[metrics.C ?? ""];
  const i = CIA[metrics.I ?? ""];
  const a = CIA[metrics.A ?? ""];

  if (
    av == null ||
    ac == null ||
    ui == null ||
    pr == null ||
    c == null ||
    i == null ||
    a == null ||
    (scope !== "U" && scope !== "C")
  ) {
    return null;
  }

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact =
    scope === "U"
      ? 6.42 * iss
      : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const exploitability = 8.22 * av * ac * pr * ui;

  if (impact <= 0) return 0;

  const base =
    scope === "U"
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);
  // CVSS spec: round up to one decimal.
  return Math.ceil(base * 10) / 10;
}

/**
 * Pick the highest CVSS v3 score across all entries — vendors often
 * publish v2 + v3 + v4 in parallel and we want the most pessimistic v3
 * read for severity bucketing.
 */
export function highestCvssV3(severity: OsvSeverityEntry[] | undefined): number | null {
  if (!severity || severity.length === 0) return null;
  let best: number | null = null;
  for (const entry of severity) {
    if (entry.type !== "CVSS_V3") continue;
    const score = parseCvssV3Score(entry.score);
    if (score == null) continue;
    if (best == null || score > best) best = score;
  }
  return best;
}

export type SeverityBucket =
  | "CRITICAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "UNKNOWN";

export function severityFromCvss(score: number | null): SeverityBucket {
  if (score == null) return "UNKNOWN";
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  return "LOW";
}

// ─── HTTP helpers ──────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Single retry on 5xx with a 2s backoff. 4xx throws immediately —
 * retrying a 400 will just produce another 400.
 */
async function osvFetch(
  path: string,
  init: RequestInit
): Promise<Response> {
  const url = `${OSV_BASE}${path}`;
  const headers = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
    ...(init.headers ?? {}),
  };

  let res = await fetch(url, { ...init, headers });
  if (res.status >= 500) {
    await sleep(RETRY_DELAY_MS);
    res = await fetch(url, { ...init, headers });
  }
  if (!res.ok) {
    throw new Error(
      `OSV ${init.method ?? "GET"} ${path} -> ${res.status} ${res.statusText}`
    );
  }
  return res;
}

// ─── Public surface ────────────────────────────────────────────────────

/**
 * Bulk lookup. The OSV response is aligned positionally with the input
 * `queries` array — index `i` in the response describes input `i`.
 * Entries with no hits come back as `{}` upstream; we normalise to
 * `{ vulns: [] }` so callers don't have to special-case.
 */
export async function queryBatch(
  queries: OsvBatchQuery[]
): Promise<OsvBatchResult[]> {
  if (queries.length === 0) return [];

  const out: OsvBatchResult[] = [];
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const chunk = queries.slice(i, i + BATCH_SIZE);
    const res = await osvFetch("/v1/querybatch", {
      method: "POST",
      body: JSON.stringify({ queries: chunk }),
    });
    const json = (await res.json()) as {
      results: Array<{ vulns?: OsvBatchHit[] }>;
    };
    const results = json.results ?? [];
    for (const r of results) {
      out.push({ vulns: Array.isArray(r.vulns) ? r.vulns : [] });
    }
    // Inter-batch pause — be polite even though OSV's stated limits are
    // generous.
    if (i + BATCH_SIZE < queries.length) {
      await sleep(INTER_REQUEST_PAUSE_MS);
    }
  }
  return out;
}

/**
 * Per-id detail fetch. Returns null on 404 (OSV occasionally returns ids
 * via querybatch that 404 on detail — withdrawn / merged records) so
 * the sync engine can simply skip rather than fail the whole run.
 */
export async function fetchVulnDetail(osvId: string): Promise<OsvVuln | null> {
  const url = `${OSV_BASE}/v1/vulns/${encodeURIComponent(osvId)}`;
  const headers = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
  };
  let res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (res.status >= 500) {
    await sleep(RETRY_DELAY_MS);
    res = await fetch(url, { headers });
    if (res.status === 404) return null;
  }
  if (!res.ok) {
    throw new Error(
      `OSV GET /v1/vulns/${osvId} -> ${res.status} ${res.statusText}`
    );
  }
  const json = (await res.json()) as OsvVuln;
  // Polite pacing between detail requests too.
  await sleep(INTER_REQUEST_PAUSE_MS);
  return json;
}
