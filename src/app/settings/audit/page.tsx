"use client";

import { Fragment, useMemo, useState } from "react";
import useSWRInfinite from "swr/infinite";
import {
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  X,
} from "lucide-react";
import { jsonFetcher } from "@/lib/fetcher";
import { useFormatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditEventRow, AuditListResponse } from "@/lib/types";

/**
 * Admin → Audit log.
 *
 * Cursor-paginated table of every admin mutation. Defaults to a 50-row
 * page, newest first. Filter dropdowns (actor / entityType / action)
 * stack as AND clauses; the "Load more" button advances the cursor
 * without losing already-loaded pages.
 *
 * The diff column is opt-in per row — clicking a row expands the
 * before/after JSON inline along with IP + UA, so the dense table view
 * stays scannable while still letting the operator drill in.
 */

const PAGE_SIZE = 50;

interface FilterState {
  actorEmail: string;
  entityType: string;
  action: string;
}

const EMPTY_FILTERS: FilterState = {
  actorEmail: "",
  entityType: "",
  action: "",
};

/**
 * Build the SWR-infinite key function for a given filter state. The
 * actor filter is server-side by email (the API also supports
 * `actorId`, but the dropdown talks in emails since that's what every
 * row already carries). For now we filter client-side on email by
 * passing `actorEmail` along as a query param the API ignores — paired
 * with the post-fetch filter below. Trade-off: avoids a second
 * users-listing query.
 */
function buildKeyFactory(filters: FilterState) {
  return (
    pageIndex: number,
    previousPageData: AuditListResponse | null
  ): string | null => {
    if (previousPageData && !previousPageData.hasMore) return null;
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    if (filters.entityType) params.set("entityType", filters.entityType);
    if (filters.action) params.set("action", filters.action);
    if (pageIndex > 0 && previousPageData?.nextBefore != null) {
      params.set("before", String(previousPageData.nextBefore));
    }
    return `/api/admin/audit?${params.toString()}`;
  };
}

export default function AuditLogPage() {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const fmt = useFormatDateTime();

  // We need an email → actorId map for the filter dropdown. Fetch the
  // first page without filters once and harvest distinct actor emails.
  // Imperfect (deleted users with no recent events drop out of the
  // dropdown), but it's the lightest read path that doesn't need a new
  // endpoint. The lookup table also covers email → id for the API call.
  const { data: pages, isLoading, isValidating, size, setSize, error, mutate } =
    useSWRInfinite<AuditListResponse>(
      buildKeyFactory(filters),
      jsonFetcher,
      {
        revalidateFirstPage: false,
        keepPreviousData: true,
      }
    );

  const allEvents: AuditEventRow[] = useMemo(() => {
    const events = (pages ?? []).flatMap((p) => p.events);
    if (!filters.actorEmail) return events;
    return events.filter((e) => e.actorEmail === filters.actorEmail);
  }, [pages, filters.actorEmail]);

  // Distinct dropdown options derived from what we've actually loaded
  // (pre-actor-filter, so picking an actor doesn't collapse the menu).
  const rawEvents = useMemo(
    () => (pages ?? []).flatMap((p) => p.events),
    [pages]
  );
  const distinctActors = useMemo(() => {
    const set = new Set<string>();
    for (const e of rawEvents) set.add(e.actorEmail);
    return Array.from(set).sort();
  }, [rawEvents]);
  const distinctEntityTypes = useMemo(() => {
    const set = new Set<string>();
    for (const e of rawEvents) set.add(e.entityType);
    return Array.from(set).sort();
  }, [rawEvents]);
  const distinctActions = useMemo(() => {
    const set = new Set<string>();
    for (const e of rawEvents) set.add(e.action);
    return Array.from(set).sort();
  }, [rawEvents]);

  const lastPage = pages?.[pages.length - 1];
  const hasMore = lastPage?.hasMore === true;
  const loadingMore = isValidating && pages && pages.length > 0;
  const filtersActive =
    filters.actorEmail !== "" ||
    filters.entityType !== "" ||
    filters.action !== "";

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Filter changes reset pagination — we want page 1 of the new filter
  // set, not the cumulative pages from the previous one.
  const updateFilter = <K extends keyof FilterState>(
    key: K,
    value: FilterState[K]
  ) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setSize(1);
    setExpanded(new Set());
    void mutate();
  };
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSize(1);
    setExpanded(new Set());
    void mutate();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight">Audit log</h3>
        <p className="text-xs text-muted-foreground">
          Append-only ledger of admin mutations. Every create / update /
          delete / trigger / upload across the admin surfaces lands here
          within seconds. Cursor-paginated, newest first.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error instanceof Error ? error.message : "failed to load"}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-muted-foreground" />
            Events
            <span className="text-muted-foreground font-normal">
              ({allEvents.length}
              {hasMore ? "+" : ""})
            </span>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="Actor"
              value={filters.actorEmail}
              options={distinctActors}
              onChange={(v) => updateFilter("actorEmail", v)}
            />
            <FilterSelect
              label="Entity"
              value={filters.entityType}
              options={distinctEntityTypes}
              onChange={(v) => updateFilter("entityType", v)}
            />
            <FilterSelect
              label="Action"
              value={filters.action}
              options={distinctActions}
              onChange={(v) => updateFilter("action", v)}
            />
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="h-3 w-3" /> Clear
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="relative max-h-[70vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead className="w-[8px]"></TableHead>
                  <TableHead className="w-[180px]">When</TableHead>
                  <TableHead className="w-[200px]">Actor</TableHead>
                  <TableHead className="w-[100px]">Action</TableHead>
                  <TableHead className="w-[140px]">Entity</TableHead>
                  <TableHead>Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && allEvents.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-xs text-muted-foreground"
                    >
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && allEvents.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-xs text-muted-foreground"
                    >
                      {filtersActive
                        ? "No events match the current filters."
                        : "No audit events yet."}
                    </TableCell>
                  </TableRow>
                )}
                {allEvents.map((ev) => {
                  const isOpen = expanded.has(ev.id);
                  return (
                    <Fragment key={ev.id}>
                      <TableRow
                        onClick={() => toggleExpand(ev.id)}
                        className="cursor-pointer hover:bg-muted/40"
                      >
                        <TableCell>
                          {isOpen ? (
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3 w-3 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">
                          {fmt(ev.createdAt)}
                        </TableCell>
                        <TableCell className="font-mono text-[11px]">
                          {ev.actorEmail}
                        </TableCell>
                        <TableCell>
                          <ActionBadge action={ev.action} />
                        </TableCell>
                        <TableCell className="font-mono text-[11px]">
                          {ev.entityType}
                          {ev.entityId ? (
                            <span className="text-muted-foreground">
                              {" "}
                              #{ev.entityId}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs">{ev.summary}</TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell colSpan={6} className="bg-muted/20">
                            <DiffPanel event={ev} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="mt-3 flex items-center justify-center">
            {hasMore ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSize(size + 1)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Load more
              </Button>
            ) : allEvents.length > 0 ? (
              <p className="text-xs text-muted-foreground">— end of log —</p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-md border bg-background px-1.5 font-mono text-[11px]"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActionBadge({ action }: { action: string }) {
  const variant = (() => {
    switch (action) {
      case "create":
        return "default";
      case "delete":
        return "destructive";
      case "update":
      case "upload":
      case "trigger":
      default:
        return "secondary";
    }
  })();
  return (
    <Badge variant={variant} className="font-mono text-[10px]">
      {action}
    </Badge>
  );
}

function DiffPanel({ event }: { event: AuditEventRow }) {
  return (
    <div className="flex flex-col gap-3 py-2 text-xs">
      <div className="grid grid-cols-2 gap-3">
        <Meta label="IP" value={event.ip ?? "—"} />
        <Meta label="User agent" value={event.userAgent ?? "—"} mono />
      </div>
      {event.diff ? (
        <div className="grid grid-cols-2 gap-3">
          <DiffBlock label="Before" value={event.diff.before} />
          <DiffBlock label="After" value={event.diff.after} />
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          No structured diff recorded for this event.
        </p>
      )}
    </div>
  );
}

function Meta({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn("text-[11px]", mono && "font-mono break-all")}>
        {value}
      </span>
    </div>
  );
}

function DiffBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <pre className="max-h-64 overflow-auto rounded-md border bg-background p-2 font-mono text-[11px] leading-snug">
        {value === null || value === undefined
          ? "null"
          : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
