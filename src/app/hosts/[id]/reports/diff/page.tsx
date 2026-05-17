"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ChevronLeft } from "lucide-react";
import { jsonFetcher } from "@/lib/fetcher";
import { useFormatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ListDiff,
  PackageChange,
  PackageDelta,
  PackageSectionDiff,
  ReportDiff,
  ScalarDiff,
} from "@/lib/reportDiff";

/**
 * Report diff viewer.
 *
 * Inline (single-column +/- gutter) rather than side-by-side. The data
 * is structured (lists of packages/services/etc.), not arbitrary text,
 * so a two-column layout would mostly leave one side empty.
 */
export default function ReportDiffPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const a = searchParams.get("a");
  const b = searchParams.get("b");

  const url =
    a && b ? `/api/hosts/${id}/reports/diff?a=${a}&b=${b}` : null;
  const { data, error, isLoading } = useSWR<ReportDiff>(url, jsonFetcher);
  const formatDt = useFormatDateTime();

  if (!a || !b) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        Missing report ids — diff URL must include both `a` and `b` query
        parameters.
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink hostId={id} />
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error instanceof Error ? error.message : "failed to load diff"}
        </div>
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink hostId={id} />
        <div className="text-sm text-muted-foreground">Loading diff…</div>
      </div>
    );
  }

  const noChanges =
    data.summary.added === 0 &&
    data.summary.removed === 0 &&
    data.summary.changed === 0;

  return (
    <div className="flex flex-col gap-6">
      <BackLink hostId={id} />

      <Card>
        <CardHeader className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <CardTitle className="font-mono">{data.hostname}</CardTitle>
            <span className="text-xs text-muted-foreground">report diff</span>
          </div>
          <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
            <ReportSideStamp
              label="A (before)"
              reportId={data.a.reportId}
              collectedAt={data.a.collectedAt}
              receivedAt={data.a.receivedAt}
              formatDt={formatDt}
            />
            <ReportSideStamp
              label="B (after)"
              reportId={data.b.reportId}
              collectedAt={data.b.collectedAt}
              receivedAt={data.b.receivedAt}
              formatDt={formatDt}
            />
          </div>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Added" value={data.summary.added} tone="success" />
        <SummaryCard
          label="Removed"
          value={data.summary.removed}
          tone="destructive"
        />
        <SummaryCard label="Changed" value={data.summary.changed} tone="warning" />
      </div>

      {noChanges && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="pt-5 text-sm text-emerald-700 dark:text-emerald-300">
            No changes detected between these two reports. The host&apos;s
            inventory was stable across the snapshot window.
          </CardContent>
        </Card>
      )}

      {data.sections.scalars.changes.length > 0 && (
        <ScalarChangesCard scalars={data.sections.scalars} />
      )}

      <PackageDiffCard diff={data.sections.packages} />

      <SimpleListDiffCard
        title="Services"
        diff={data.sections.services}
        renderRow={(s) => s.unit}
        rowKey={(s) => s.unit}
      />
      <SimpleListDiffCard
        title="Listeners"
        diff={data.sections.listeners}
        renderRow={(l) => `${l.proto}  ${l.addr}:${l.port}`}
        rowKey={(l) => `${l.proto}:${l.addr}:${l.port}`}
      />
      <SimpleListDiffCard
        title="Containers"
        diff={data.sections.containers}
        renderRow={(c) => `${c.name}  ${c.image}  (${c.id.slice(0, 12)})`}
        rowKey={(c) => c.id}
      />
      <SimpleListDiffCard
        title="IP addresses"
        diff={data.sections.ipAddresses}
        renderRow={(ip) => `${ip.addr}  (${ip.iface})`}
        rowKey={(ip) => `${ip.iface}:${ip.addr}`}
      />
      <SimpleListDiffCard
        title="Kernel mitigations"
        diff={data.sections.kernelMitigations}
        renderRow={(m) => `${m.vuln} — ${m.state}`}
        rowKey={(m) => `${m.vuln}:${m.state}`}
      />
      <SimpleListDiffCard
        title="Loaded modules"
        diff={data.sections.loadedModules}
        renderRow={(m) => m.name}
        rowKey={(m) => m.name}
      />
      <SimpleListDiffCard
        title="Pending updates"
        diff={data.sections.pendingUpdates}
        renderRow={(u) => `${u.name}  →  ${u.available_version}`}
        rowKey={(u) => `${u.name}:${u.available_version}`}
      />
      <SimpleListDiffCard
        title="Container runtime"
        diff={data.sections.containerRuntime}
        renderRow={(r) => `${r.name}  ${r.version}`}
        rowKey={(r) => `${r.name}:${r.version}`}
      />
      <SimpleListDiffCard
        title="Snap packages"
        diff={data.sections.snapPackages}
        renderRow={(p) => `${p.name}  ${p.version}`}
        rowKey={(p) => `${p.name}:${p.version}`}
      />
      <SimpleListDiffCard
        title="Flatpak packages"
        diff={data.sections.flatpakPackages}
        renderRow={(p) => `${p.name}  ${p.version}`}
        rowKey={(p) => `${p.name}:${p.version}`}
      />
    </div>
  );
}

// ─── Header bits ─────────────────────────────────────────────────────────
function BackLink({ hostId }: { hostId: string }) {
  return (
    <div>
      <Link
        href={`/hosts/${hostId}`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-3 w-3" /> Back to host
      </Link>
    </div>
  );
}

function ReportSideStamp({
  label,
  reportId,
  collectedAt,
  receivedAt,
  formatDt,
}: {
  label: string;
  reportId: number;
  collectedAt: string;
  receivedAt: string;
  formatDt: (iso: string | Date) => string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label} — #{reportId}
      </span>
      <span className="font-mono text-xs">{formatDt(collectedAt)}</span>
      <span className="text-[10px] text-muted-foreground">
        received {formatDt(receivedAt)}
      </span>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "destructive" | "warning";
}) {
  const toneClass = {
    success:
      "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
    destructive:
      "border-destructive/30 bg-destructive/5 text-destructive",
    warning:
      "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  }[tone];
  return (
    <Card className={cn("border", toneClass)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-[10px] font-medium uppercase tracking-wider">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <span className="font-mono text-2xl">{value}</span>
      </CardContent>
    </Card>
  );
}

// ─── Scalar changes ──────────────────────────────────────────────────────
function ScalarChangesCard({ scalars }: { scalars: ScalarDiff }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium">
          Scalar fields
          <span className="ml-2 text-[10px] font-normal text-muted-foreground">
            {scalars.changes.length} changed
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>From (A)</TableHead>
              <TableHead>To (B)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scalars.changes.map((c) => (
              <TableRow key={c.field}>
                <TableCell className="font-mono text-xs">{c.field}</TableCell>
                <TableCell className="font-mono text-xs text-destructive">
                  {formatScalar(c.from)}
                </TableCell>
                <TableCell className="font-mono text-xs text-emerald-700 dark:text-emerald-400">
                  {formatScalar(c.to)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ─── Generic section card ────────────────────────────────────────────────
const COLLAPSE_THRESHOLD = 20;

function SectionShell({
  title,
  unchanged,
  hasContent,
  emptyOk,
  children,
}: {
  title: string;
  unchanged: number;
  hasContent: boolean;
  /** When true, render the "no changes" card body instead of hiding. */
  emptyOk?: boolean;
  children: React.ReactNode;
}) {
  // Hide the card entirely when the section is absent from BOTH reports
  // (no rows + zero unchanged). When it exists but is unchanged across
  // the window, we still hide unless `emptyOk` is set — keeps the page
  // focused on actual deltas.
  if (!hasContent && unchanged === 0 && !emptyOk) return null;
  if (!hasContent && !emptyOk) return null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-xs font-medium">{title}</CardTitle>
        <span className="font-mono text-[10px] text-muted-foreground">
          {unchanged} unchanged
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">{children}</CardContent>
    </Card>
  );
}

function DiffRow({
  kind,
  children,
}: {
  kind: "added" | "removed" | "changed";
  children: React.ReactNode;
}) {
  const tone = {
    added:
      "border-l-emerald-500/60 bg-emerald-500/5 text-emerald-800 dark:text-emerald-200",
    removed:
      "border-l-destructive/60 bg-destructive/5 text-destructive",
    changed:
      "border-l-amber-500/60 bg-amber-500/5 text-amber-800 dark:text-amber-200",
  }[kind];
  const gutter = kind === "added" ? "+" : kind === "removed" ? "−" : "~";
  return (
    <div
      className={cn(
        "flex items-baseline gap-2 border-l-2 px-2 py-1 font-mono text-xs",
        tone
      )}
    >
      <span className="select-none opacity-60">{gutter}</span>
      <span className="break-all">{children}</span>
    </div>
  );
}

function CollapsibleList<T>({
  rows,
  kind,
  rowKey,
  renderRow,
}: {
  rows: T[];
  kind: "added" | "removed" | "changed";
  rowKey: (row: T) => string;
  renderRow: (row: T) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const visible =
    expanded || rows.length <= COLLAPSE_THRESHOLD
      ? rows
      : rows.slice(0, COLLAPSE_THRESHOLD);
  const remaining = rows.length - visible.length;
  return (
    <div className="flex flex-col gap-1">
      {visible.map((row) => (
        <DiffRow key={rowKey(row)} kind={kind}>
          {renderRow(row)}
        </DiffRow>
      ))}
      {remaining > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-[11px]"
          onClick={() => setExpanded(true)}
        >
          Show {remaining} more
        </Button>
      )}
      {expanded && rows.length > COLLAPSE_THRESHOLD && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-[11px]"
          onClick={() => setExpanded(false)}
        >
          Collapse
        </Button>
      )}
    </div>
  );
}

// ─── List diff card (services/listeners/containers/etc.) ─────────────────
function SimpleListDiffCard<T>({
  title,
  diff,
  renderRow,
  rowKey,
}: {
  title: string;
  diff: ListDiff<T>;
  renderRow: (row: T) => React.ReactNode;
  rowKey: (row: T) => string;
}) {
  const hasContent = diff.added.length > 0 || diff.removed.length > 0;
  return (
    <SectionShell
      title={title}
      unchanged={diff.unchanged}
      hasContent={hasContent}
    >
      <CollapsibleList
        rows={diff.added}
        kind="added"
        rowKey={rowKey}
        renderRow={renderRow}
      />
      <CollapsibleList
        rows={diff.removed}
        kind="removed"
        rowKey={rowKey}
        renderRow={renderRow}
      />
    </SectionShell>
  );
}

// ─── Package diff card ───────────────────────────────────────────────────
function PackageDiffCard({ diff }: { diff: PackageSectionDiff }) {
  const hasContent =
    diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
  return (
    <SectionShell
      title="Packages"
      unchanged={diff.unchanged}
      hasContent={hasContent}
    >
      <CollapsibleList<PackageChange>
        rows={diff.changed}
        kind="changed"
        rowKey={(p) => `c:${p.ecosystem}:${p.name}:${p.arch}`}
        renderRow={(p) => (
          <span>
            <span className="text-muted-foreground">[{p.ecosystem}]</span>{" "}
            {p.name}
            {p.arch ? (
              <span className="text-muted-foreground"> ({p.arch})</span>
            ) : null}
            {": "}
            <span className="line-through opacity-70">{p.fromVersion}</span>
            {" → "}
            <span>{p.toVersion}</span>
          </span>
        )}
      />
      <CollapsibleList<PackageDelta>
        rows={diff.added}
        kind="added"
        rowKey={(p) => `a:${p.ecosystem}:${p.name}:${p.version}:${p.arch}`}
        renderRow={(p) => (
          <span>
            <span className="text-muted-foreground">[{p.ecosystem}]</span>{" "}
            {p.name} {p.version}
            {p.arch ? (
              <span className="text-muted-foreground"> ({p.arch})</span>
            ) : null}
          </span>
        )}
      />
      <CollapsibleList<PackageDelta>
        rows={diff.removed}
        kind="removed"
        rowKey={(p) => `r:${p.ecosystem}:${p.name}:${p.version}:${p.arch}`}
        renderRow={(p) => (
          <span>
            <span className="text-muted-foreground">[{p.ecosystem}]</span>{" "}
            {p.name} {p.version}
            {p.arch ? (
              <span className="text-muted-foreground"> ({p.arch})</span>
            ) : null}
          </span>
        )}
      />
    </SectionShell>
  );
}
