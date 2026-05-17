"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Search } from "lucide-react";
import { jsonFetcher } from "@/lib/fetcher";
import { timeAgo, hoursSince, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TagChip } from "@/components/TagChip";
import { SEVERITY_COLORS } from "@/lib/severity";
import type { DisplayPrefs, HostRow, TagSummary } from "@/lib/types";

/**
 * Hosts dashboard — the landing page for the operator. Staleness dot
 * thresholds are operator-configurable (admin → Collector config →
 * "Host status thresholds") and surfaced to every logged-in user via
 * GET /api/display-prefs.
 *
 * Tag filtering is client-side over the existing /api/hosts payload —
 * each row already carries its full `tags` array, so we don't issue
 * a second query when the chip set changes.
 */

const DEFAULT_PREFS: DisplayPrefs = {
  staleHostAmberDays: 1,
  staleHostRedDays: 3,
};

const MAX_TAG_CHIPS_PER_ROW = 3;

/**
 * Worst-severity dot + count for the host list. Renders red for any
 * CRITICAL count, else orange for any HIGH, else nothing. Wraps in a
 * Link so the operator can click straight through to the per-host vuln
 * tab — no separate host-filter on /vulnerabilities yet, so we land on
 * the host detail page anchored to the vulnerabilities tab via the
 * URL hash. The host detail Tabs component reads `defaultValue` so a
 * hash navigation alone won't switch tabs; we keep the affordance to
 * navigate to the host detail and let the operator click the tab.
 *
 * Why no spec-suggested ?host= filter: /vulnerabilities is fleet-wide
 * and adding a single-host filter would duplicate the host detail
 * vuln tab without adding cross-host context. Cleaner to send the
 * operator to the host page directly.
 */
function VulnIndicator({
  hostId,
  counts,
}: {
  hostId: number;
  counts: { CRITICAL: number; HIGH: number };
}) {
  const worst: "CRITICAL" | "HIGH" | null = counts.CRITICAL > 0
    ? "CRITICAL"
    : counts.HIGH > 0
    ? "HIGH"
    : null;
  if (!worst) return <span className="text-xs text-muted-foreground">—</span>;
  const count = counts[worst];
  return (
    <Link
      href={`/hosts/${hostId}`}
      onClick={(e) => e.stopPropagation()}
      title={`${count} ${worst.toLowerCase()} vulnerabilit${count === 1 ? "y" : "ies"} — click for host detail`}
      className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-muted/60"
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: SEVERITY_COLORS[worst] }}
      />
      <span className="font-mono text-[11px] tabular-nums">{count}</span>
    </Link>
  );
}

function StaleDot({
  lastReportAt,
  amberDays,
  redDays,
}: {
  lastReportAt: string;
  amberDays: number;
  redDays: number;
}) {
  const hrs = hoursSince(new Date(lastReportAt));
  const amberHrs = amberDays * 24;
  const redHrs = redDays * 24;
  const tone =
    hrs < amberHrs
      ? "bg-emerald-500"
      : hrs < redHrs
      ? "bg-amber-500"
      : "bg-red-500";
  return (
    <span
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", tone)}
      title={`Last report ${timeAgo(lastReportAt)}`}
    />
  );
}

export default function HostsDashboard() {
  const router = useRouter();
  const { data, isLoading, error } = useSWR<HostRow[]>(
    "/api/hosts",
    jsonFetcher
  );
  // Tag taxonomy for the filter chip row. /api/tags is non-admin so
  // this works for every logged-in user. Empty list = no filter row.
  const { data: tags } = useSWR<TagSummary[]>("/api/tags", jsonFetcher);
  // Staleness thresholds. Fall back to the schema defaults during the
  // initial request so the dots don't flash a different color when the
  // prefs land — operators rarely change them, and 1/3 days is the
  // shipped default.
  const { data: prefs } = useSWR<DisplayPrefs>(
    "/api/display-prefs",
    jsonFetcher
  );
  const amberDays = prefs?.staleHostAmberDays ?? DEFAULT_PREFS.staleHostAmberDays;
  const redDays = prefs?.staleHostRedDays ?? DEFAULT_PREFS.staleHostRedDays;
  const [search, setSearch] = useState("");
  // OR-semantics: "show hosts with ANY of the selected tags". Stored
  // as a Set for O(1) toggle and membership tests.
  const [activeTagIds, setActiveTagIds] = useState<Set<number>>(new Set());

  // Per-tag host counts shown in the filter chips. Computed over the
  // full host list so the count is the unconditional total — toggling
  // a chip doesn't shrink another chip's count.
  const tagCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const h of data ?? []) {
      for (const t of h.tags) {
        m.set(t.id, (m.get(t.id) ?? 0) + 1);
      }
    }
    return m;
  }, [data]);

  const filteredHosts = useMemo(() => {
    if (!data) return [];
    if (activeTagIds.size === 0) return data;
    return data.filter((h) => h.tags.some((t) => activeTagIds.has(t.id)));
  }, [data, activeTagIds]);

  const toggleTag = (id: number) => {
    setActiveTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearTags = () => setActiveTagIds(new Set());

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = search.trim();
    if (!q) return;
    router.push(`/search?package=${encodeURIComponent(q)}`);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Hosts</h2>
        <p className="text-sm text-muted-foreground">
          Every host that has ever shipped a report. Click a row for detail.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Search packages across fleet</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitSearch} className="flex gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="e.g. openssl, bash, log4j…"
              className="font-mono"
            />
            <Button type="submit" disabled={!search.trim()}>
              <Search className="h-4 w-4" /> Search
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3">
          <div className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">
              Reporting hosts{" "}
              <span className="text-muted-foreground font-normal">
                ({filteredHosts.length}
                {activeTagIds.size > 0 && data
                  ? ` of ${data.length}`
                  : ""}
                )
              </span>
            </CardTitle>
          </div>
          {tags && tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Filter by tag
              </span>
              {tags.map((t) => (
                <TagChip
                  key={t.id}
                  tag={t}
                  active={activeTagIds.has(t.id)}
                  count={tagCounts.get(t.id) ?? 0}
                  onClick={() => toggleTag(t.id)}
                />
              ))}
              {activeTagIds.size > 0 && (
                <button
                  type="button"
                  onClick={clearTags}
                  className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error instanceof Error ? error.message : "failed to load"}
            </div>
          )}
          {!error && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Hostname</TableHead>
                  <TableHead>OS</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Kernel</TableHead>
                  <TableHead>Arch</TableHead>
                  <TableHead>Private IP</TableHead>
                  <TableHead className="text-right">Packages</TableHead>
                  <TableHead>Vulns</TableHead>
                  <TableHead>Last report</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-xs text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && (data?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-xs text-muted-foreground">
                      No hosts have reported yet. Create an ingest token from{" "}
                      <Link href="/settings/tokens" className="underline">
                        Ingest tokens
                      </Link>{" "}
                      and run the agent.
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading &&
                  (data?.length ?? 0) > 0 &&
                  filteredHosts.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={10}
                        className="text-center text-xs text-muted-foreground"
                      >
                        No hosts match the active tag filter.
                      </TableCell>
                    </TableRow>
                  )}
                {filteredHosts.map((h) => (
                  <TableRow
                    key={h.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/hosts/${h.id}`)}
                  >
                    <TableCell>
                      <StaleDot
                        lastReportAt={h.lastReportAt}
                        amberDays={amberDays}
                        redDays={redDays}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{h.hostname}</TableCell>
                    <TableCell>
                      <Badge variant="muted">
                        {h.osName} {h.osVersion}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <HostTagsCell tags={h.tags} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {h.kernel ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {h.arch ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {h.privateIp ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {h.packageCount}
                    </TableCell>
                    <TableCell>
                      <VulnIndicator
                        hostId={h.id}
                        counts={h.vulnSeverityCounts}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {timeAgo(h.lastReportAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Compact tag list for the host-list row. Caps visible chips at
 * MAX_TAG_CHIPS_PER_ROW with a "+N more" affordance — the title
 * attribute on the overflow indicator lets operators see the full
 * set on hover without leaving the page.
 */
function HostTagsCell({ tags }: { tags: TagSummary[] }) {
  if (tags.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const visible = tags.slice(0, MAX_TAG_CHIPS_PER_ROW);
  const overflow = tags.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((t) => (
        <TagChip key={t.id} tag={t} />
      ))}
      {overflow > 0 && (
        <span
          className="text-[10px] text-muted-foreground"
          title={tags
            .slice(MAX_TAG_CHIPS_PER_ROW)
            .map((t) => t.name)
            .join(", ")}
        >
          +{overflow} more
        </span>
      )}
    </div>
  );
}
