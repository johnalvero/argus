"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { ChevronLeft, FileJson, GitCompare, Loader2, Tags, X } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/fetcher";
import { timeAgo, formatBytes, humanizeDuration } from "@/lib/utils";
import { useFormatDateTime } from "@/lib/datetime";
import { useMe } from "@/lib/useMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TagChip } from "@/components/TagChip";
import { SeverityBadge } from "@/components/SeverityBadge";
import { SeverityStrip } from "@/components/SeverityStrip";
import { emptySeverityCounts, toSeverityBucket } from "@/lib/severity";
import type {
  HostDetail,
  HostVulnerabilitySummary,
  KernelMitigationEntry,
  LoadedModuleEntry,
  PendingUpdates,
  ContainerRuntimeEntry,
  SeverityCounts,
  TagSummary,
  VirtualizationInfo,
  UptimeInfo,
} from "@/lib/types";

/**
 * Host detail page. Header card with summary, tabs for packages /
 * services / listeners / containers / report history. Clicking a
 * historical report row opens a dialog with the raw JSON.
 */

export default function HostDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, error, isLoading, mutate } = useSWR<HostDetail>(
    `/api/hosts/${id}`,
    jsonFetcher
  );
  const { data: me } = useMe();

  const [pkgQuery, setPkgQuery] = useState("");
  const [pkgEcosystem, setPkgEcosystem] = useState<string>("all");
  const [openReportId, setOpenReportId] = useState<number | null>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  // Local "select A then B" state for the diff picker. Lives in
  // component state, not the URL — the user hasn't committed to a diff
  // yet, just picked one side. Once they click the second row we route
  // to /hosts/[id]/reports/diff?a=...&b=... and the URL takes over.
  const [diffAId, setDiffAId] = useState<number | null>(null);
  const router = useRouter();
  const formatDt = useFormatDateTime();

  // Ecosystem counts for the filter chips — derived from the full
  // package list, not the filtered one (so toggles always show the
  // total per ecosystem, never the current-filter subset).
  const ecosystemCounts = useMemo(() => {
    if (!data) return [] as Array<{ key: string; count: number }>;
    const m = new Map<string, number>();
    for (const p of data.packages) {
      m.set(p.ecosystem, (m.get(p.ecosystem) ?? 0) + 1);
    }
    // Stable order: os first, then language ecosystems alphabetical,
    // then alternate package managers (snap, flatpak) last. They live
    // in the same column as language ecosystems but conceptually sit
    // alongside the OS package manager, so we group them at the end.
    const tail = new Set(["snap", "flatpak"]);
    const rank = (k: string) => (k === "os" ? 0 : tail.has(k) ? 2 : 1);
    return Array.from(m.entries())
      .sort((a, b) => {
        const ra = rank(a[0]);
        const rb = rank(b[0]);
        if (ra !== rb) return ra - rb;
        return a[0].localeCompare(b[0]);
      })
      .map(([key, count]) => ({ key, count }));
  }, [data]);

  const filteredPackages = useMemo(() => {
    if (!data) return [];
    const q = pkgQuery.trim().toLowerCase();
    return data.packages.filter((p) => {
      if (pkgEcosystem !== "all" && p.ecosystem !== pkgEcosystem) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.version.toLowerCase().includes(q)
      );
    });
  }, [data, pkgQuery, pkgEcosystem]);

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
          href="/hosts"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Back to hosts
        </Link>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-3">
            <CardTitle className="font-mono">{data.hostname}</CardTitle>
            <Badge variant="muted">
              {data.osName} {data.osVersion}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.tags.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">
                No tags assigned.
              </span>
            ) : (
              data.tags.map((t) => <TagChip key={t.id} tag={t} />)
            )}
            {me?.isAdmin && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTagEditorOpen(true)}
                className="h-6 px-1.5 text-[11px]"
              >
                <Tags className="h-3 w-3" /> Edit tags
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs md:grid-cols-4">
          <Field label="Host ID" value={data.hostId} mono />
          <Field label="Kernel" value={data.kernel ?? "—"} mono />
          <Field label="Arch" value={data.arch ?? "—"} mono />
          <Field
            label="Package manager"
            value={data.packageManager ?? "—"}
            mono
          />
          <Field label="Agent" value={data.agentVersion ?? "—"} mono />
          {data.ipAddresses.length === 0 ? (
            <Field label="IP address" value="—" mono />
          ) : (
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                IP address{data.ipAddresses.length > 1 ? "es" : ""}
              </span>
              <div className="flex flex-col gap-0.5 font-mono">
                {data.ipAddresses.map((ip, i) => (
                  <div key={`${ip.iface}-${ip.addr}-${i}`} className="flex items-baseline gap-2">
                    <span>{ip.addr}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {ip.iface}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Field label="Packages" value={String(data.packageCount)} mono />
          <Field
            label="First seen"
            value={`${timeAgo(data.firstSeenAt)} (${formatDt(
              data.firstSeenAt
            )})`}
          />
          <Field
            label="Last report"
            value={`${timeAgo(data.lastReportAt)} (${formatDt(
              data.lastReportAt
            )})`}
          />
        </CardContent>
      </Card>

      <Tabs defaultValue="packages">
        <TabsList>
          <TabsTrigger value="packages">Packages</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="listeners">Listeners</TabsTrigger>
          <TabsTrigger value="containers">Containers</TabsTrigger>
          {hasSecurityPosture(data) && (
            <TabsTrigger value="security">Security posture</TabsTrigger>
          )}
          <TabsTrigger value="vulnerabilities">
            Vulnerabilities
            {data.vulnerabilities.length > 0 && (
              <span className="ml-1.5 text-[10px] opacity-70">
                {data.vulnerabilities.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history">Report history</TabsTrigger>
        </TabsList>

        <TabsContent value="packages">
          <Card>
            <CardHeader className="flex flex-col gap-3">
              <Input
                value={pkgQuery}
                onChange={(e) => setPkgQuery(e.target.value)}
                placeholder="Filter packages…"
                className="font-mono"
              />
              {ecosystemCounts.length > 1 && (
                <div className="flex flex-wrap items-center gap-1">
                  <EcosystemChip
                    label="All"
                    count={data.packages.length}
                    active={pkgEcosystem === "all"}
                    onClick={() => setPkgEcosystem("all")}
                  />
                  {ecosystemCounts.map(({ key, count }) => (
                    <EcosystemChip
                      key={key}
                      label={key}
                      count={count}
                      active={pkgEcosystem === key}
                      onClick={() => setPkgEcosystem(key)}
                    />
                  ))}
                </div>
              )}
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ecosystem</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Arch / Location</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPackages.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center text-xs text-muted-foreground"
                      >
                        No packages match.
                      </TableCell>
                    </TableRow>
                  )}
                  {filteredPackages.map((p, i) => (
                    <TableRow key={`${p.ecosystem}-${p.name}-${p.version}-${p.arch}-${i}`}>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {p.ecosystem}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{p.name}</TableCell>
                      <TableCell className="font-mono text-xs">{p.version}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {p.ecosystem === "os"
                          ? p.arch || "—"
                          : p.location || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="services">
          <Card>
            <CardContent className="pt-5">
              {data.services.length === 0 ? (
                <p className="text-xs text-muted-foreground">No services reported.</p>
              ) : (
                <ul className="grid grid-cols-2 gap-1 md:grid-cols-3">
                  {data.services.map((s, i) => (
                    <li key={i} className="font-mono text-xs">
                      {s.unit}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="listeners">
          <Card>
            <CardContent className="pt-5">
              {data.listeners.length === 0 ? (
                <p className="text-xs text-muted-foreground">No listeners reported.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Proto</TableHead>
                      <TableHead>Address</TableHead>
                      <TableHead>Port</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.listeners.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">{l.proto}</TableCell>
                        <TableCell className="font-mono text-xs">{l.addr}</TableCell>
                        <TableCell className="font-mono text-xs">{l.port}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="containers">
          <Card>
            <CardContent className="pt-5">
              {data.containers.length === 0 ? (
                <p className="text-xs text-muted-foreground">No containers reported.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Image</TableHead>
                      <TableHead>ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.containers.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">{c.name}</TableCell>
                        <TableCell className="font-mono text-xs">{c.image}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {c.id.slice(0, 12)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {hasSecurityPosture(data) && (
          <TabsContent value="security">
            <SecurityPostureSection data={data} />
          </TabsContent>
        )}

        <TabsContent value="vulnerabilities">
          <HostVulnerabilitiesSection vulnerabilities={data.vulnerabilities} />
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
              <div className="text-xs text-muted-foreground">
                {data.reports.length} report
                {data.reports.length === 1 ? "" : "s"} on file
              </div>
              {data.reports.length >= 2 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    router.push(
                      `/hosts/${id}/reports/diff?a=${data.reports[1]!.id}&b=${data.reports[0]!.id}`
                    )
                  }
                >
                  <GitCompare className="h-3 w-3" /> Compare last two reports
                </Button>
              )}
            </CardHeader>
            <CardContent className="pt-0">
              {diffAId !== null && (
                <div className="mb-3 flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                  <span>
                    Comparing against #{diffAId}
                    {(() => {
                      const r = data.reports.find((x) => x.id === diffAId);
                      return r ? ` (${formatDt(r.collectedAt)})` : "";
                    })()}{" "}
                    — pick another report to diff.
                  </span>
                  <button
                    type="button"
                    onClick={() => setDiffAId(null)}
                    className="inline-flex items-center gap-1 text-[11px] underline-offset-2 hover:underline"
                  >
                    <X className="h-3 w-3" /> Cancel
                  </button>
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Received</TableHead>
                    <TableHead>Collected</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Hash</TableHead>
                    <TableHead></TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.reports.map((r) => {
                    const isSelectedA = diffAId === r.id;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="text-xs">
                          {formatDt(r.receivedAt)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatDt(r.collectedAt)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {formatBytes(r.payloadSize)}
                        </TableCell>
                        <TableCell className="font-mono text-[10px] text-muted-foreground">
                          {r.hash.slice(0, 12)}…
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setOpenReportId(r.id)}
                          >
                            <FileJson className="h-3 w-3" /> Raw JSON
                          </Button>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant={isSelectedA ? "default" : "ghost"}
                            size="sm"
                            disabled={data.reports.length < 2}
                            title={
                              data.reports.length < 2
                                ? "Need at least two reports to diff"
                                : undefined
                            }
                            onClick={() => {
                              if (isSelectedA) {
                                setDiffAId(null);
                                return;
                              }
                              if (diffAId === null) {
                                setDiffAId(r.id);
                                return;
                              }
                              // Second pick — commit. Convention: the
                              // older report is A (before), newer is B
                              // (after). Reports are listed newest
                              // first, so smaller id == older.
                              const a = Math.min(diffAId, r.id);
                              const b = Math.max(diffAId, r.id);
                              setDiffAId(null);
                              router.push(
                                `/hosts/${id}/reports/diff?a=${a}&b=${b}`
                              );
                            }}
                          >
                            <GitCompare className="h-3 w-3" />{" "}
                            {isSelectedA ? "A" : "Diff"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RawReportDialog
        hostId={Number(id)}
        reportId={openReportId}
        onOpenChange={(open) => {
          if (!open) setOpenReportId(null);
        }}
      />

      {me?.isAdmin && (
        <HostTagEditorDialog
          open={tagEditorOpen}
          hostId={Number(id)}
          currentTags={data.tags}
          onClose={() => setTagEditorOpen(false)}
          onSaved={async () => {
            setTagEditorOpen(false);
            await mutate();
          }}
        />
      )}
    </div>
  );
}

/**
 * Admin-only picker: toggleable chips for every tag in the taxonomy,
 * pre-selected to match the host's current tag set. Save replaces the
 * whole set via PUT /api/admin/hosts/[id]/tags.
 */
function HostTagEditorDialog({
  open,
  hostId,
  currentTags,
  onClose,
  onSaved,
}: {
  open: boolean;
  hostId: number;
  currentTags: TagSummary[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { data: allTags } = useSWR<TagSummary[]>(
    open ? "/api/tags" : null,
    jsonFetcher
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  // Re-seed selection from the host's current tags whenever the dialog
  // opens, so a Cancel + reopen doesn't preserve mid-edit state.
  useEffect(() => {
    if (open) {
      setSelected(new Set(currentTags.map((t) => t.id)));
    }
  }, [open, currentTags]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/hosts/${hostId}/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagIds: Array.from(selected) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(body?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      toast.success("Tags updated");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit tags</DialogTitle>
          <DialogDescription>
            Click a tag to toggle it. Save replaces the host&apos;s tag
            set with the current selection.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[80px] flex-wrap gap-1.5">
          {!allTags && (
            <span className="text-xs text-muted-foreground">Loading…</span>
          )}
          {allTags && allTags.length === 0 && (
            <span className="text-xs text-muted-foreground">
              No tags exist yet. Create one in Settings &rarr; Tags.
            </span>
          )}
          {allTags?.map((t) => (
            <TagChip
              key={t.id}
              tag={t}
              active={selected.has(t.id)}
              onClick={() => toggle(t.id)}
            />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Tags className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EcosystemChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors " +
        (active
          ? "bg-foreground text-background"
          : "bg-muted/30 text-muted-foreground hover:text-foreground")
      }
    >
      <span>{label}</span>
      <span className="opacity-70">{count}</span>
    </button>
  );
}

function Field({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** Native tooltip — surfaces additional context on hover (e.g. all
   * interface addresses when the primary IP is shown collapsed). */
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={mono ? "font-mono" : ""}>{value}</span>
    </div>
  );
}

// ─── Security posture ─────────────────────────────────────────────────
function hasSecurityPosture(data: HostDetail): boolean {
  return Boolean(
    data.virtualization ||
      data.uptime ||
      data.containerRuntime ||
      data.kernelMitigations ||
      data.pendingUpdates ||
      data.loadedModules
  );
}

// Color mapping for vulnerability/mitigation strings. Green for any
// "Not affected" / "Mitigation:" answer (the kernel handled it). Red
// strictly for the word "Vulnerable" at the start. Anything else falls
// through to a muted neutral — unknown is unknown.
function mitigationVariant(state: string): "success" | "destructive" | "muted" {
  const s = state.trim();
  if (/^vulnerable/i.test(s)) return "destructive";
  if (/^not affected$/i.test(s) || /^mitigation/i.test(s)) return "success";
  return "muted";
}

function SecurityPostureSection({ data }: { data: HostDetail }) {
  const formatDt = useFormatDateTime();
  return (
    <div className="flex flex-col gap-4">
      {/* Top-row stat cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StatCard
          label="Virtualization"
          value={data.virtualization?.type ?? "—"}
          caption={
            data.virtualization
              ? `source: ${data.virtualization.source}`
              : "not reported"
          }
        />
        <StatCard
          label="Uptime"
          value={data.uptime ? humanizeDuration(data.uptime.seconds) : "—"}
          caption={
            data.uptime
              ? `booted ${formatDt(data.uptime.boot_time)}`
              : "not reported"
          }
        />
        <StatCard
          label="Container runtime"
          value={
            data.containerRuntime
              ? String(data.containerRuntime.length)
              : "—"
          }
          caption={
            data.containerRuntime && data.containerRuntime.length > 0
              ? data.containerRuntime.map((r) => r.name).join(", ")
              : "none detected"
          }
        />
      </div>

      {data.kernelMitigations && (
        <KernelMitigationsCard entries={data.kernelMitigations} />
      )}
      {data.pendingUpdates && (
        <PendingUpdatesCard updates={data.pendingUpdates} />
      )}
      {data.loadedModules && (
        <LoadedModulesCard entries={data.loadedModules} />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-0.5">
        <span className="font-mono text-lg">{value}</span>
        <span className="text-[11px] text-muted-foreground">{caption}</span>
      </CardContent>
    </Card>
  );
}

function KernelMitigationsCard({ entries }: { entries: KernelMitigationEntry[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium">
          Kernel mitigations
          <span className="ml-2 text-[10px] font-normal text-muted-foreground">
            {entries.length} vulnerabilit{entries.length === 1 ? "y" : "ies"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vulnerability</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((m, i) => (
              <TableRow key={`${m.vuln}-${i}`}>
                <TableCell className="font-mono text-xs">{m.vuln}</TableCell>
                <TableCell>
                  <Badge variant={mitigationVariant(m.state)}>{m.state}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PendingUpdatesCard({ updates }: { updates: PendingUpdates }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? updates.items : updates.items.slice(0, 10);
  const remaining = updates.items.length - visible.length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium">
          Pending updates
          <span className="ml-2 text-[10px] font-normal text-muted-foreground">
            {updates.count} from local package cache
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {updates.items.length === 0 ? (
          <p className="text-xs text-muted-foreground">No pending updates.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Package</TableHead>
                  <TableHead>Available version</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((u, i) => (
                  <TableRow key={`${u.name}-${i}`}>
                    <TableCell className="font-mono text-xs">{u.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {u.available_version}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {remaining > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setShowAll(true)}
              >
                Show {remaining} more
              </Button>
            )}
            {showAll && updates.items.length > 10 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setShowAll(false)}
              >
                Collapse
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LoadedModulesCard({ entries }: { entries: LoadedModuleEntry[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium">
          Loaded kernel modules
          <span className="ml-2 text-[10px] font-normal text-muted-foreground">
            {entries.length} loaded
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* <details> keeps this collapsed by default — the list can be
            300+ entries on a fat server and would otherwise dominate
            the tab. */}
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Show modules
          </summary>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((m, i) => (
                <TableRow key={`${m.name}-${i}`}>
                  <TableCell className="font-mono text-xs">{m.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {formatBytes(m.size_bytes)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      </CardContent>
    </Card>
  );
}

// ─── Per-host vulnerabilities ─────────────────────────────────────────
function HostVulnerabilitiesSection({
  vulnerabilities,
}: {
  vulnerabilities: HostVulnerabilitySummary[];
}) {
  // Per-host severity histogram. Computed client-side from the already-
  // shipped vuln list so we don't burn a second API call.
  const counts: SeverityCounts = useMemo(() => {
    const c = emptySeverityCounts();
    for (const v of vulnerabilities) {
      c[toSeverityBucket(v.severity)]++;
    }
    return c;
  }, [vulnerabilities]);

  if (vulnerabilities.length === 0) {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5">
        <CardContent className="pt-5 text-sm text-emerald-700 dark:text-emerald-300">
          No known vulnerabilities matched this host.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SeverityStrip counts={counts} />
      <Card>
        <CardContent className="pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severity</TableHead>
                <TableHead>OSV ID</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Package</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Ecosystem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vulnerabilities.map((v) => (
                <TableRow key={`${v.id}-${v.packageName}-${v.packageVersion}`}>
                  <TableCell>
                    <SeverityBadge severity={v.severity} />
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/vulnerabilities/${v.id}`}
                      className="font-mono text-xs underline-offset-2 hover:underline"
                    >
                      {v.osvId}
                    </Link>
                  </TableCell>
                  <TableCell
                    className="max-w-[42ch] text-xs"
                    title={v.summary}
                  >
                    {v.summary.length > 120
                      ? v.summary.slice(0, 119).trimEnd() + "…"
                      : v.summary}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {v.packageName}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {v.packageVersion}
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {v.ecosystem}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function RawReportDialog({
  hostId,
  reportId,
  onOpenChange,
}: {
  hostId: number;
  reportId: number | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data } = useSWR<{ payload: string }>(
    reportId ? `/api/hosts/${hostId}/reports/${reportId}` : null,
    jsonFetcher
  );
  const pretty = useMemo(() => {
    if (!data) return "";
    try {
      return JSON.stringify(JSON.parse(data.payload), null, 2);
    } catch {
      return data.payload;
    }
  }, [data]);
  return (
    <Dialog open={reportId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Raw report payload</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px]">
          {pretty || "Loading…"}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
