"use client";

import { Suspense, use, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { jsonFetcher } from "@/lib/fetcher";
import { useFormatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SeverityBadge } from "@/components/SeverityBadge";
import { TagChip } from "@/components/TagChip";
import type { VulnerabilityDetail } from "@/lib/types";

/**
 * /vulnerabilities/[id]
 *
 * Detail prose is wrapped in a max-w-3xl container so the long-form
 * OSV details stay readable (~80ch). The affected-hosts table
 * deliberately sits outside that constraint — wide tables want the
 * full viewport.
 *
 * The back link restores the operator's prior filter state via the
 * `?from=` round-trip pointer the list page packs in.
 */

type SortKey = "hostname" | "firstSeen";

function VulnerabilityDetailPageInner({ id }: { id: string }) {
  const params = useSearchParams();
  const fromQs = params.get("from") ?? "";
  const backHref = fromQs
    ? `/vulnerabilities?${decodeURIComponent(fromQs)}`
    : "/vulnerabilities";

  const { data, isLoading, error } = useSWR<VulnerabilityDetail>(
    `/api/vulnerabilities/${id}`,
    jsonFetcher
  );
  const formatDt = useFormatDateTime();

  const [sortKey, setSortKey] = useState<SortKey>("hostname");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sortedHosts = useMemo(() => {
    if (!data) return [];
    const arr = [...data.affectedHosts];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "hostname") {
        cmp = a.hostname.localeCompare(b.hostname);
      } else {
        cmp =
          new Date(a.firstSeenAt).getTime() -
          new Date(b.firstSeenAt).getTime();
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [data, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "firstSeen" ? "desc" : "asc");
    }
  };

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {error instanceof Error ? error.message : "failed to load"}
      </div>
    );
  }
  if (isLoading || !data) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Back to vulnerabilities
        </Link>
      </div>

      <div className="max-w-3xl">
        <Card>
          <CardHeader className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={data.severity} />
              <span className="font-mono text-lg">{data.osvId}</span>
            </div>
            <h2 className="text-base font-semibold leading-snug">
              {data.summary}
            </h2>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <Caption
                label="CVSS"
                value={data.cvssScore !== null ? data.cvssScore.toFixed(1) : "—"}
                mono
              />
              <Caption
                label="Published"
                value={data.publishedAt ? formatDt(data.publishedAt) : "—"}
              />
              <Caption
                label="Modified"
                value={data.modifiedAt ? formatDt(data.modifiedAt) : "—"}
              />
              <Caption label="Fetched" value={formatDt(data.fetchedAt)} />
            </div>
            {data.aliases.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Aliases
                </span>
                {data.aliases.map((a) => (
                  <span
                    key={a}
                    className="inline-flex items-center rounded-sm border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {a}
                  </span>
                ))}
              </div>
            )}
          </CardHeader>
        </Card>
      </div>

      {data.details && (
        <div className="max-w-3xl">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium">Details</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Often markdown upstream — render as preformatted text so
                  inline backticks and line breaks survive without
                  pulling a markdown lib for v1. */}
              <pre className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
                {data.details}
              </pre>
            </CardContent>
          </Card>
        </div>
      )}

      {data.references.length > 0 && (
        <div className="max-w-3xl">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium">References</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-1">
                {data.references.map((r, i) => (
                  <li
                    key={`${r.url}-${i}`}
                    className="flex items-baseline gap-2 text-xs"
                  >
                    <span className="font-mono text-[10px] uppercase text-muted-foreground">
                      {r.type}
                    </span>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 break-all text-foreground underline-offset-2 hover:underline"
                    >
                      {r.url}
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium">
            Affected hosts
            <span className="ml-2 text-[10px] font-normal text-muted-foreground">
              {data.affectedHosts.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.affectedHosts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No hosts currently match this vulnerability.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <SortHeader
                      label="Hostname"
                      active={sortKey === "hostname"}
                      dir={sortDir}
                      onClick={() => toggleSort("hostname")}
                    />
                  </TableHead>
                  <TableHead>OS</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Package</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Ecosystem</TableHead>
                  <TableHead>
                    <SortHeader
                      label="First seen"
                      active={sortKey === "firstSeen"}
                      dir={sortDir}
                      onClick={() => toggleSort("firstSeen")}
                    />
                  </TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedHosts.map((h, i) => (
                  <TableRow key={`${h.hostId}-${h.packageName}-${i}`}>
                    <TableCell>
                      <Link
                        href={`/hosts/${h.hostId}`}
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        {h.hostname}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {h.osName} {h.osVersion}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {h.tags.length === 0 ? (
                          <span className="text-[10px] text-muted-foreground">
                            —
                          </span>
                        ) : (
                          h.tags.map((t) => <TagChip key={t.id} tag={t} />)
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {h.packageName}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {h.packageVersion}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {h.ecosystem}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDt(h.firstSeenAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDt(h.lastSeenAt)}
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

function Caption({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider">{label}</span>
      <span className={cn(mono && "font-mono", "text-foreground")}>{value}</span>
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 text-left text-xs",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      {active && (
        <span className="text-[8px]">{dir === "asc" ? "▲" : "▼"}</span>
      )}
    </button>
  );
}

export default function VulnerabilityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <VulnerabilityDetailPageInner id={id} />
    </Suspense>
  );
}
