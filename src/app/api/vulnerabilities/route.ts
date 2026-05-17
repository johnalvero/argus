import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { emptySeverityCounts, toSeverityBucket } from "@/lib/severity";
import type {
  SeverityBucket,
  VulnerabilityListResponse,
  VulnerabilityRow,
} from "@/lib/types";

/**
 * GET /api/vulnerabilities — cookie-authed list with severity / ecosystem
 * / tag / search filters.
 *
 * Filter intersection semantics:
 *   • severity     OR within the set, AND with everything else
 *   • ecosystem    OR within the set
 *   • tag          OR within the set (any host carrying any of these tags)
 *   • search       substring on osvId OR summary
 *
 * We compute the filtered id set first, then fan out to:
 *   1. total count
 *   2. severityCounts over the FULL filtered set (NOT the page) — the
 *      strip cards must reflect the filter, not the current page.
 *   3. limit/offset slice → aggregate hostCount + ecosystems per row.
 *
 * The list contract caps `limit` at 200 to bound the work per request;
 * the UI uses "Load more" with offset so the typical session never
 * pulls everything in one shot.
 */

const ALLOWED_SEVERITIES: SeverityBucket[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
];
const ALLOWED_ECOSYSTEMS = ["os", "pip", "npm", "gem", "composer", "cargo"];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseCsv(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTagIds(raw: string | null): number[] {
  return parseCsv(raw)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);

  const severityFilter = parseCsv(url.searchParams.get("severity"))
    .map((s) => s.toUpperCase())
    .filter((s): s is SeverityBucket =>
      (ALLOWED_SEVERITIES as string[]).includes(s)
    );
  const ecosystemFilter = parseCsv(url.searchParams.get("ecosystem")).filter(
    (e) => ALLOWED_ECOSYSTEMS.includes(e)
  );
  const tagFilter = parseTagIds(url.searchParams.get("tag"));
  const search = (url.searchParams.get("search") ?? "").trim();

  const limit = (() => {
    const raw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.floor(raw));
  })();
  const offset = (() => {
    const raw = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return Math.floor(raw);
  })();

  // ─── Build the vuln-level WHERE ────────────────────────────────────
  // severity + search live directly on Vulnerability.
  // ecosystem and tag live on HostVulnerability/Host(Tag) — pushed
  // into a `hostVulns: { some: ... }` predicate so a vuln matches when
  // ANY of its (host, package) rows match.
  const vulnWhere: Prisma.VulnerabilityWhereInput = {};
  if (severityFilter.length > 0) {
    vulnWhere.severity = { in: severityFilter };
  }
  if (search) {
    // SQLite is case-insensitive by default for ASCII via the default
    // collation; we still apply `contains` on both columns for
    // substring matching. Prisma's `mode: insensitive` is Postgres-only.
    vulnWhere.OR = [
      { osvId: { contains: search } },
      { summary: { contains: search } },
    ];
  }

  const hostVulnSub: Prisma.HostVulnerabilityWhereInput = {};
  if (ecosystemFilter.length > 0) {
    hostVulnSub.ecosystem = { in: ecosystemFilter };
  }
  if (tagFilter.length > 0) {
    hostVulnSub.host = { tags: { some: { tagId: { in: tagFilter } } } };
  }
  if (Object.keys(hostVulnSub).length > 0) {
    vulnWhere.hostVulns = { some: hostVulnSub };
  }

  // ─── Filtered id set ────────────────────────────────────────────────
  const allMatching = await prisma.vulnerability.findMany({
    where: vulnWhere,
    select: { id: true, severity: true },
    // Sort by severity rank desc, then modified desc, then id desc.
    // We sort in JS because Prisma + SQLite can't express the bucket
    // rank without a CASE expression — and the filtered set is small
    // (capped by total vulns we've ever fetched, low thousands).
  });

  const severityCounts = emptySeverityCounts();
  for (const v of allMatching) {
    severityCounts[toSeverityBucket(v.severity)]++;
  }

  const total = allMatching.length;

  // ─── Page slice ─────────────────────────────────────────────────────
  // Order severity desc, then we fetch the modifiedAt/osvId for stable
  // pagination. Same JS sort because of the bucket-rank issue above.
  const SEVERITY_RANK: Record<SeverityBucket, number> = {
    CRITICAL: 5,
    HIGH: 4,
    MEDIUM: 3,
    LOW: 2,
    UNKNOWN: 1,
  };
  const sortedIds = await prisma.vulnerability.findMany({
    where: vulnWhere,
    select: { id: true, severity: true, modifiedAt: true, osvId: true },
  });
  sortedIds.sort((a, b) => {
    const rankDelta =
      SEVERITY_RANK[toSeverityBucket(b.severity)] -
      SEVERITY_RANK[toSeverityBucket(a.severity)];
    if (rankDelta !== 0) return rankDelta;
    const am = a.modifiedAt?.getTime() ?? 0;
    const bm = b.modifiedAt?.getTime() ?? 0;
    if (am !== bm) return bm - am;
    return a.osvId.localeCompare(b.osvId);
  });
  const pageIds = sortedIds.slice(offset, offset + limit).map((v) => v.id);

  if (pageIds.length === 0) {
    const body: VulnerabilityListResponse = {
      items: [],
      total,
      severityCounts,
    };
    return NextResponse.json(body);
  }

  // ─── Aggregate per-row hostCount + ecosystems ──────────────────────
  // One read of all HostVulnerability rows tied to the page's vuln ids,
  // grouped in JS. The page is capped at MAX_LIMIT vulns so the joined
  // row count is bounded.
  const hvRows = await prisma.hostVulnerability.findMany({
    where: { vulnerabilityId: { in: pageIds } },
    select: { vulnerabilityId: true, hostId: true, ecosystem: true },
  });
  const hostsByVuln = new Map<number, Set<number>>();
  const ecosystemsByVuln = new Map<number, Set<string>>();
  for (const r of hvRows) {
    let h = hostsByVuln.get(r.vulnerabilityId);
    if (!h) {
      h = new Set();
      hostsByVuln.set(r.vulnerabilityId, h);
    }
    h.add(r.hostId);
    let e = ecosystemsByVuln.get(r.vulnerabilityId);
    if (!e) {
      e = new Set();
      ecosystemsByVuln.set(r.vulnerabilityId, e);
    }
    e.add(r.ecosystem);
  }

  const pageVulns = await prisma.vulnerability.findMany({
    where: { id: { in: pageIds } },
    select: {
      id: true,
      osvId: true,
      summary: true,
      severity: true,
      cvssScore: true,
      publishedAt: true,
      modifiedAt: true,
    },
  });
  const byId = new Map(pageVulns.map((v) => [v.id, v]));

  const items: VulnerabilityRow[] = pageIds
    .map((id) => byId.get(id))
    .filter((v): v is NonNullable<typeof v> => Boolean(v))
    .map((v) => ({
      id: v.id,
      osvId: v.osvId,
      summary: v.summary,
      severity: v.severity,
      cvssScore: v.cvssScore,
      publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
      modifiedAt: v.modifiedAt ? v.modifiedAt.toISOString() : null,
      hostCount: hostsByVuln.get(v.id)?.size ?? 0,
      ecosystems: Array.from(ecosystemsByVuln.get(v.id) ?? []).sort(),
    }));

  const body: VulnerabilityListResponse = { items, total, severityCounts };
  return NextResponse.json(body);
}
