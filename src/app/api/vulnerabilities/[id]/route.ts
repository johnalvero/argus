import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import type {
  VulnerabilityAffectedHost,
  VulnerabilityDetail,
  VulnReferenceEntry,
} from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/vulnerabilities/[id] — full vuln record + every (host, package)
 * row that's currently matched to it.
 *
 * `aliases` and `references` are stored as opaque JSON strings on the
 * Vulnerability row (forward-compat with osv.dev's evolving shape). We
 * parse-and-validate here so the client sees real arrays, falling back
 * to empty when a historical row is malformed rather than 500.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await requireAuth(req);
  if (user instanceof NextResponse) return user;

  const { id } = await ctx.params;
  const vulnId = Number(id);
  if (!Number.isFinite(vulnId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const vuln = await prisma.vulnerability.findUnique({
    where: { id: vulnId },
    include: {
      hostVulns: {
        include: {
          host: {
            include: {
              tags: {
                include: { tag: true },
                orderBy: { tag: { name: "asc" } },
              },
            },
          },
        },
        orderBy: [{ host: { hostname: "asc" } }, { packageName: "asc" }],
      },
    },
  });
  if (!vuln) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const aliases: string[] = (() => {
    if (!vuln.aliases) return [];
    try {
      const arr = JSON.parse(vuln.aliases);
      return Array.isArray(arr)
        ? arr.filter((s): s is string => typeof s === "string")
        : [];
    } catch {
      return [];
    }
  })();

  // URL scheme allowlist — defense against javascript:/data:/file: URLs
  // sneaking in via a malicious OSV record. The detail page renders these
  // as <a href>, so anything other than http(s) is a foot-gun.
  const isSafeRefUrl = (url: string): boolean => {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  };

  const references: VulnReferenceEntry[] = (() => {
    if (!vuln.references) return [];
    try {
      const arr = JSON.parse(vuln.references);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(
          (e): e is { type: unknown; url: unknown } =>
            typeof e === "object" && e !== null
        )
        .map((e) => ({
          type: typeof e.type === "string" ? e.type : "WEB",
          url: typeof e.url === "string" ? e.url : "",
        }))
        .filter((e) => e.url && isSafeRefUrl(e.url));
    } catch {
      return [];
    }
  })();

  const affectedHosts: VulnerabilityAffectedHost[] = vuln.hostVulns.map(
    (hv) => ({
      hostId: hv.host.id,
      hostname: hv.host.hostname,
      osName: hv.host.osName,
      osVersion: hv.host.osVersion,
      tags: hv.host.tags.map((ht) => ({
        id: ht.tag.id,
        name: ht.tag.name,
        color: ht.tag.color,
      })),
      packageName: hv.packageName,
      packageVersion: hv.packageVersion,
      ecosystem: hv.ecosystem,
      firstSeenAt: hv.firstSeenAt.toISOString(),
      lastSeenAt: hv.lastSeenAt.toISOString(),
    })
  );

  const body: VulnerabilityDetail = {
    id: vuln.id,
    osvId: vuln.osvId,
    summary: vuln.summary,
    details: vuln.details,
    severity: vuln.severity,
    cvssScore: vuln.cvssScore,
    aliases,
    references,
    publishedAt: vuln.publishedAt ? vuln.publishedAt.toISOString() : null,
    modifiedAt: vuln.modifiedAt ? vuln.modifiedAt.toISOString() : null,
    fetchedAt: vuln.fetchedAt.toISOString(),
    affectedHosts,
  };
  return NextResponse.json(body);
}
