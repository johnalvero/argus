"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ShieldAlert } from "lucide-react";
import { jsonFetcher } from "@/lib/fetcher";
import { useFormatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { emptySeverityCounts } from "@/lib/severity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SeverityBadge } from "@/components/SeverityBadge";
import { SeverityStrip } from "@/components/SeverityStrip";
import { TagChip } from "@/components/TagChip";
import type {
  SeverityBucket,
  TagSummary,
  VulnerabilityListResponse,
} from "@/lib/types";

/**
 * /vulnerabilities — cross-fleet vuln browser.
 *
 * URL is the source of truth for every filter so views are shareable:
 *   ?q=openssl&sev=CRITICAL,HIGH&eco=os,pip&tag=3,5&page=2
 *
 * The "Load more" pager bumps `page` (1-indexed) and the API call
 * translates that to `offset = (page - 1) * PAGE_SIZE`. Severity strip
 * counts always come from the FILTERED response — toggling a bucket
 * does not zero the others, which would be confusing.
 */

const PAGE_SIZE = 50;
const ALLOWED_SEVERITIES: SeverityBucket[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
];
const ALLOWED_ECOSYSTEMS = ["os", "pip", "npm", "gem", "composer", "cargo"];
const SUMMARY_TRUNCATE = 120;

function parseCsvList<T extends string>(raw: string | null, allowed: T[]): T[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as string[]).includes(s));
}

function parseTagIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function VulnerabilitiesPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const formatDt = useFormatDateTime();

  // ─── URL-derived filter state ──────────────────────────────────────
  const urlSeverity = useMemo(
    () => new Set(parseCsvList(params.get("sev"), ALLOWED_SEVERITIES)),
    [params]
  );
  const urlEcosystem = useMemo(
    () => new Set(parseCsvList(params.get("eco"), ALLOWED_ECOSYSTEMS)),
    [params]
  );
  const urlTagIds = useMemo(() => new Set(parseTagIds(params.get("tag"))), [
    params,
  ]);
  const urlSearch = params.get("q") ?? "";
  const urlPage = (() => {
    const n = Number(params.get("page") ?? 1);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  })();

  // Local input state for the search box; URL is the source of truth
  // but debouncing means we keep the typed text in local state until
  // the 300ms timer fires.
  const [searchInput, setSearchInput] = useState(urlSearch);
  useEffect(() => {
    setSearchInput(urlSearch);
  }, [urlSearch]);

  // Build the next URL given a delta to the filter set. Always resets
  // page to 1 when a filter changes — otherwise "Load more" past page 1
  // collides with shrinking result counts.
  const pushFilters = useCallback(
    (overrides: {
      severity?: Set<SeverityBucket>;
      ecosystem?: Set<string>;
      tagIds?: Set<number>;
      search?: string;
      page?: number;
    }) => {
      const next = new URLSearchParams();
      const sev = overrides.severity ?? urlSeverity;
      const eco = overrides.ecosystem ?? urlEcosystem;
      const tag = overrides.tagIds ?? urlTagIds;
      const q = overrides.search ?? urlSearch;
      const page = overrides.page ?? 1;
      if (sev.size > 0) next.set("sev", Array.from(sev).join(","));
      if (eco.size > 0) next.set("eco", Array.from(eco).join(","));
      if (tag.size > 0) next.set("tag", Array.from(tag).join(","));
      if (q) next.set("q", q);
      if (page > 1) next.set("page", String(page));
      const qs = next.toString();
      router.replace(qs ? `/vulnerabilities?${qs}` : "/vulnerabilities", {
        scroll: false,
      });
    },
    [router, urlSeverity, urlEcosystem, urlTagIds, urlSearch]
  );

  // Debounce the search input → URL push.
  useEffect(() => {
    if (searchInput === urlSearch) return;
    const t = setTimeout(() => {
      pushFilters({ search: searchInput.trim() });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, urlSearch, pushFilters]);

  // ─── API call ──────────────────────────────────────────────────────
  const offset = (urlPage - 1) * PAGE_SIZE;
  const limit = urlPage * PAGE_SIZE; // fetch everything up to current page
  const apiQs = new URLSearchParams();
  if (urlSeverity.size > 0)
    apiQs.set("severity", Array.from(urlSeverity).join(","));
  if (urlEcosystem.size > 0)
    apiQs.set("ecosystem", Array.from(urlEcosystem).join(","));
  if (urlTagIds.size > 0)
    apiQs.set("tag", Array.from(urlTagIds).join(","));
  if (urlSearch) apiQs.set("search", urlSearch);
  apiQs.set("limit", String(limit));
  apiQs.set("offset", "0");

  const swrKey = `/api/vulnerabilities?${apiQs.toString()}`;
  const { data, isLoading, error } = useSWR<VulnerabilityListResponse>(
    swrKey,
    jsonFetcher,
    { keepPreviousData: true }
  );

  // Tags for the filter chips. Same /api/tags read the host list uses.
  const { data: tags } = useSWR<TagSummary[]>("/api/tags", jsonFetcher);

  const severityCounts = data?.severityCounts ?? emptySeverityCounts();
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasMore = items.length < total;

  // ─── Handlers ──────────────────────────────────────────────────────
  const toggleSeverity = (bucket: SeverityBucket) => {
    const next = new Set(urlSeverity);
    if (next.has(bucket)) next.delete(bucket);
    else next.add(bucket);
    pushFilters({ severity: next });
  };
  const toggleEcosystem = (eco: string) => {
    const next = new Set(urlEcosystem);
    if (next.has(eco)) next.delete(eco);
    else next.add(eco);
    pushFilters({ ecosystem: next });
  };
  const toggleTag = (id: number) => {
    const next = new Set(urlTagIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    pushFilters({ tagIds: next });
  };
  const loadMore = () => pushFilters({ page: urlPage + 1 });
  const clearAll = () =>
    pushFilters({
      severity: new Set(),
      ecosystem: new Set(),
      tagIds: new Set(),
      search: "",
    });

  const anyFilterActive =
    urlSeverity.size > 0 ||
    urlEcosystem.size > 0 ||
    urlTagIds.size > 0 ||
    urlSearch.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Vulnerabilities</h2>
        <p className="text-sm text-muted-foreground">
          Cross-fleet view. CVE data from osv.dev — sync from the header button.
        </p>
      </div>

      <SeverityStrip
        counts={severityCounts}
        active={urlSeverity}
        onToggle={toggleSeverity}
      />

      <Card>
        <CardHeader className="flex flex-col gap-3">
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search OSV id or summary…"
            className="font-mono"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Ecosystem
            </span>
            {ALLOWED_ECOSYSTEMS.map((eco) => (
              <EcosystemChip
                key={eco}
                label={eco}
                active={urlEcosystem.has(eco)}
                onClick={() => toggleEcosystem(eco)}
              />
            ))}
          </div>
          {tags && tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Tag
              </span>
              {tags.map((t) => (
                <TagChip
                  key={t.id}
                  tag={t}
                  active={urlTagIds.has(t.id)}
                  onClick={() => toggleTag(t.id)}
                />
              ))}
            </div>
          )}
          {anyFilterActive && (
            <button
              type="button"
              onClick={clearAll}
              className="self-start text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear all filters
            </button>
          )}
        </CardHeader>
        <CardContent>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error instanceof Error ? error.message : "failed to load"}
            </div>
          )}
          {!error && total === 0 && !isLoading && (
            <EmptyState anyFilterActive={anyFilterActive} onClear={clearAll} />
          )}
          {!error && total > 0 && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Severity</TableHead>
                    <TableHead>OSV ID</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead className="text-right">Hosts</TableHead>
                    <TableHead>Ecosystems</TableHead>
                    <TableHead>Modified</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell>
                        <SeverityBadge severity={v.severity} />
                      </TableCell>
                      <TableCell>
                        <Link
                          href={vulnDetailHref(v.id, swrKey)}
                          className="font-mono text-xs underline-offset-2 hover:underline"
                        >
                          {v.osvId}
                        </Link>
                      </TableCell>
                      <TableCell
                        className="max-w-[42ch] text-xs"
                        title={v.summary}
                      >
                        {truncate(v.summary, SUMMARY_TRUNCATE)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {v.hostCount}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {v.ecosystems.map((e) => (
                            <span
                              key={e}
                              className="inline-flex items-center rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                            >
                              {e}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {v.modifiedAt ? formatDt(v.modifiedAt) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Showing {items.length} of {total}
                </span>
                {hasMore && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={loadMore}
                    disabled={isLoading}
                  >
                    Load more
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Build the detail link with a `?from=` round-trip pointer so the back
 * link on the detail page can restore the operator's exact filter
 * state. We pack the current API query string (minus pagination) so
 * shared links stay clean.
 */
function vulnDetailHref(id: number, apiKey: string): string {
  // apiKey looks like "/api/vulnerabilities?severity=...". Strip the
  // limit/offset since those don't belong in the URL state, and rebase
  // onto the page path.
  const qIdx = apiKey.indexOf("?");
  const fromQs = qIdx >= 0 ? apiKey.slice(qIdx + 1) : "";
  const fromParams = new URLSearchParams(fromQs);
  fromParams.delete("limit");
  fromParams.delete("offset");
  // Translate API param names back to page param names for round-trip.
  const pageParams = new URLSearchParams();
  const sev = fromParams.get("severity");
  if (sev) pageParams.set("sev", sev);
  const eco = fromParams.get("ecosystem");
  if (eco) pageParams.set("eco", eco);
  const tag = fromParams.get("tag");
  if (tag) pageParams.set("tag", tag);
  const search = fromParams.get("search");
  if (search) pageParams.set("q", search);
  const from = pageParams.toString();
  return from
    ? `/vulnerabilities/${id}?from=${encodeURIComponent(from)}`
    : `/vulnerabilities/${id}`;
}

function EmptyState({
  anyFilterActive,
  onClear,
}: {
  anyFilterActive: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <ShieldAlert className="h-8 w-8 text-muted-foreground/50" />
      {anyFilterActive ? (
        <>
          <p className="text-sm text-muted-foreground">
            No vulnerabilities match the current filters.
          </p>
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            No vulnerabilities cached yet.
          </p>
          <p className="max-w-md text-xs text-muted-foreground/80">
            Either no hosts have shipped a report or the operator hasn&apos;t
            run a CVE sync. Click <strong>Sync CVEs</strong> in the header
            to populate from osv.dev.
          </p>
        </>
      )}
    </div>
  );
}

function EcosystemChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-transparent bg-muted/40 text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}

export default function VulnerabilitiesPage() {
  return (
    <Suspense fallback={null}>
      <VulnerabilitiesPageInner />
    </Suspense>
  );
}
