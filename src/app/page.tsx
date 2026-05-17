"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  Bell,
  CheckCircle2,
  History,
  Inbox,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Server,
} from "lucide-react";
import { jsonFetcher } from "@/lib/fetcher";
import { timeAgo, cn } from "@/lib/utils";
import { useUserTimezone } from "@/lib/datetime";
import { useMe } from "@/lib/useMe";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TagChip } from "@/components/TagChip";
import { SEVERITY_COLORS } from "@/lib/severity";
import type {
  ComplianceGrade,
  CveSyncRunRow,
  DashboardActivity,
  DashboardResponse,
  DashboardTopHost,
} from "@/lib/types";

/**
 * Argus dashboard — the home page.
 *
 * Single SWR call to /api/dashboard fans out into all the cards below.
 * Auto-refresh is intentionally OFF (no polling) — operator hits the
 * "Refresh" button or revisits the page to get a new snapshot. The
 * dashboard is hit a lot; we don't burn DB cycles refreshing for
 * a tab in the background.
 */

const REFRESH_REVALIDATE_DELAY_MS = 250;

// Same palette the compliance scorecard uses. Re-declared here rather
// than imported because the compliance page co-locates these in its
// component file; if a third surface needs them we'll lift them out.
const GRADE_TEXT: Record<ComplianceGrade, string> = {
  A: "text-emerald-500",
  B: "text-blue-500",
  C: "text-amber-500",
  D: "text-orange-500",
  F: "text-red-500",
};

function greetingFor(date: Date, timeZone: string): string {
  // Use a formatter pinned to the user's zone so the greeting matches
  // the timestamp we render next to it — otherwise the local browser
  // hour disagrees with a user whose profile pins a different tz.
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).format(date);
  const hour = Number(hourStr);
  if (!Number.isFinite(hour)) return "Hello";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function formatDayInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: undefined,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/**
 * Set the browser tab title to include the current grade so an operator
 * scanning tabs sees the fleet state at a glance. We patch document.title
 * directly because we don't have an easy SSR hand-off for this surface.
 */
function useGlanceableTitle(grade: ComplianceGrade | null) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const previous = document.title;
    document.title = grade ? `Argus · ${grade}` : "Argus";
    return () => {
      document.title = previous;
    };
  }, [grade]);
}

export default function DashboardPage() {
  const { data: me } = useMe();
  const timezone = useUserTimezone();
  const { data, isLoading, error, isValidating, mutate } =
    useSWR<DashboardResponse>("/api/dashboard", jsonFetcher, {
      revalidateOnFocus: false,
    });

  useGlanceableTitle(data?.compliance.grade ?? null);

  // Render the greeting + date deterministically. Pre-mount we render
  // an empty placeholder so SSR/CSR stays in sync without a hydration
  // warning on the time string.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const greetingLine = useMemo(() => {
    if (!mounted) return null;
    const now = new Date();
    return `${greetingFor(now, timezone)} — ${formatDayInZone(now, timezone)} · ${timezone}`;
  }, [mounted, timezone]);

  const refresh = async () => {
    // Tiny delay so the spinner is perceivable even on a hot cache.
    await new Promise((r) => setTimeout(r, REFRESH_REVALIDATE_DELAY_MS));
    await mutate();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Dashboard</h2>
          <p className="text-sm text-muted-foreground">
            {greetingLine ?? "Loading…"}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={isLoading || isValidating}
          className="gap-1.5"
        >
          {isValidating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error instanceof Error ? error.message : "failed to load dashboard"}
        </div>
      )}

      {/* Hero row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <ComplianceCard data={data} />
        <HostsCard data={data} />
        <VulnerabilitiesCard data={data} />
        <NotificationsCard data={data} />
      </div>

      {/* Two-column lower row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TopHostsCard hosts={data?.topHosts} loading={!data && isLoading} />
        <ActivityCard
          items={data?.activity}
          loading={!data && isLoading}
        />
      </div>

      {/* Admin-only sync history */}
      {me?.isAdmin && (
        <RecentSyncsCard syncs={data?.recentSyncs} loading={!data && isLoading} />
      )}
    </div>
  );
}

// ─── Hero cards ────────────────────────────────────────────────────────

function StatCard({
  href,
  children,
  title,
}: {
  href: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={`Open ${title}`}
      className="group rounded-md border bg-card text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </Link>
  );
}

function StatHeader({
  label,
  icon: Icon,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-5 pt-5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Icon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
    </div>
  );
}

function ComplianceCard({ data }: { data: DashboardResponse | undefined }) {
  const score = data?.compliance.score;
  const grade = data?.compliance.grade ?? null;
  const color = grade ? GRADE_TEXT[grade] : "text-muted-foreground";
  return (
    <StatCard href="/compliance" title="compliance">
      <StatHeader label="Compliance" icon={ShieldCheck} />
      <div className="flex items-end justify-between gap-2 p-5 pt-3">
        <span className={cn("font-mono text-5xl font-bold leading-none", color)}>
          {grade ?? "—"}
        </span>
        <div className="flex flex-col items-end leading-tight">
          <span
            className={cn(
              "font-mono text-2xl font-semibold tabular-nums",
              color
            )}
          >
            {score ?? "—"}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            score / 100
          </span>
        </div>
      </div>
    </StatCard>
  );
}

function HostsCard({ data }: { data: DashboardResponse | undefined }) {
  const total = data?.hosts.total ?? 0;
  const active = data?.hosts.active ?? 0;
  const stale = data?.hosts.stale ?? 0;
  const dead = data?.hosts.dead ?? 0;
  return (
    <StatCard href="/hosts" title="hosts">
      <StatHeader label="Hosts" icon={Server} />
      <div className="flex items-end justify-between gap-2 p-5 pt-3">
        <span className="font-mono text-5xl font-bold leading-none tabular-nums">
          {data ? total : "—"}
        </span>
        <div className="flex flex-col gap-1 leading-tight">
          <HostDotRow color="bg-emerald-500" count={active} label="active" />
          <HostDotRow color="bg-amber-500" count={stale} label="stale" />
          <HostDotRow color="bg-red-500" count={dead} label="dead" />
        </div>
      </div>
    </StatCard>
  );
}

function HostDotRow({
  color,
  count,
  label,
}: {
  color: string;
  count: number;
  label: string;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
      <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color)} />
      <span className="font-mono tabular-nums text-foreground">{count}</span>
      <span>{label}</span>
    </div>
  );
}

function VulnerabilitiesCard({ data }: { data: DashboardResponse | undefined }) {
  const critical = data?.vulnerabilities.openCritical ?? 0;
  const high = data?.vulnerabilities.openHigh ?? 0;
  const newCrit = data?.vulnerabilities.newCriticalLast24h ?? 0;
  const total = critical + high;
  return (
    <StatCard
      href="/vulnerabilities?sev=CRITICAL,HIGH"
      title="open vulnerabilities"
    >
      <StatHeader label="Open vulnerabilities" icon={ShieldAlert} />
      <div className="flex items-end justify-between gap-2 p-5 pt-3">
        <span
          className={cn(
            "font-mono text-5xl font-bold leading-none tabular-nums",
            critical > 0
              ? "text-red-500"
              : high > 0
                ? "text-orange-500"
                : "text-emerald-500"
          )}
        >
          {data ? total : "—"}
        </span>
        <div className="flex flex-col items-end gap-1 leading-tight">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: SEVERITY_COLORS.CRITICAL }}
            />
            <span className="font-mono tabular-nums text-foreground">
              {critical}
            </span>
            <span>CRITICAL</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: SEVERITY_COLORS.HIGH }}
            />
            <span className="font-mono tabular-nums text-foreground">
              {high}
            </span>
            <span>HIGH</span>
          </div>
          {newCrit > 0 && (
            <span className="font-mono text-[10px] tabular-nums text-amber-500">
              +{newCrit} new in 24h
            </span>
          )}
        </div>
      </div>
    </StatCard>
  );
}

function NotificationsCard({ data }: { data: DashboardResponse | undefined }) {
  const unread = data?.notifications.unreadCount ?? 0;
  const caption = !data
    ? "in your inbox"
    : unread === 0
      ? "all caught up"
      : "in your inbox";
  return (
    <StatCard href="/notifications" title="notifications">
      <StatHeader label="Notifications" icon={Inbox} />
      <div className="flex items-end justify-between gap-2 p-5 pt-3">
        <span
          className={cn(
            "font-mono text-5xl font-bold leading-none tabular-nums",
            unread > 0 ? "text-foreground" : "text-emerald-500"
          )}
        >
          {data ? unread : "—"}
        </span>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </div>
    </StatCard>
  );
}

// ─── Top hosts ──────────────────────────────────────────────────────────

function TopHostsCard({
  hosts,
  loading,
}: {
  hosts: DashboardTopHost[] | undefined;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Top hosts needing attention</CardTitle>
        <p className="text-xs text-muted-foreground">
          Hosts with CRITICAL or HIGH vulnerabilities, longest-waiting first.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {loading && (
          <div className="rounded-md border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
            Loading…
          </div>
        )}
        {!loading && hosts && hosts.length === 0 && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-xs text-emerald-500">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            All clear — no hosts have CRITICAL or HIGH vulnerabilities.
          </div>
        )}
        {!loading &&
          hosts &&
          hosts.map((h) => <TopHostRow key={h.id} host={h} />)}
      </CardContent>
    </Card>
  );
}

function TopHostRow({ host }: { host: DashboardTopHost }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/20 px-3 py-2 transition-colors hover:bg-muted/40">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {host.criticalCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-[11px] tabular-nums">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: SEVERITY_COLORS.CRITICAL }}
              />
              {host.criticalCount}
            </span>
          )}
          {host.highCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-[11px] tabular-nums">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: SEVERITY_COLORS.HIGH }}
              />
              {host.highCount}
            </span>
          )}
          <Link
            href={`/hosts/${host.id}`}
            className="truncate font-mono text-xs underline-offset-2 hover:underline"
          >
            {host.hostname}
          </Link>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          last report {timeAgo(host.lastReportAt)}
        </span>
      </div>
      {host.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          {host.tags.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Activity stream ────────────────────────────────────────────────────

function ActivityCard({
  items,
  loading,
}: {
  items: DashboardActivity[] | undefined;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Activity</CardTitle>
        <p className="text-xs text-muted-foreground">
          Notifications, audit events, and CVE syncs from the last 24 hours.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {loading && (
          <div className="rounded-md border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
            Loading…
          </div>
        )}
        {!loading && items && items.length === 0 && (
          <div className="rounded-md border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
            Nothing in the last 24 hours.
          </div>
        )}
        {!loading &&
          items &&
          items.map((a, i) => <ActivityRow key={`${a.kind}-${a.at}-${i}`} item={a} />)}
      </CardContent>
    </Card>
  );
}

function ActivityRow({ item }: { item: DashboardActivity }) {
  if (item.kind === "notification") {
    const body = (
      <>
        <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs">{item.title}</span>
          <span className="text-[10px] text-muted-foreground">
            {item.watchlistName || "watchlist"}
          </span>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {timeAgo(item.at)}
        </span>
      </>
    );
    return item.href ? (
      <Link
        href={item.href}
        className="flex items-start gap-2 rounded-sm px-2 py-1.5 transition-colors hover:bg-muted/50"
      >
        {body}
      </Link>
    ) : (
      <div className="flex items-start gap-2 rounded-sm px-2 py-1.5">{body}</div>
    );
  }
  if (item.kind === "audit") {
    return (
      <div className="flex items-start gap-2 rounded-sm px-2 py-1.5">
        <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs">{item.summary}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {item.actorEmail} · {item.action} {item.entityType}
          </span>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {timeAgo(item.at)}
        </span>
      </div>
    );
  }
  // cve_sync
  return (
    <div className="flex items-start gap-2 rounded-sm px-2 py-1.5">
      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs">
          CVE sync · <span className="font-mono">{item.status}</span>
        </span>
        <span className="text-[10px] text-muted-foreground">
          {item.vulnsDiscovered} vulns / {item.hostsAffected} hosts ·{" "}
          {item.newVulns} new
        </span>
      </div>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {timeAgo(item.at)}
      </span>
    </div>
  );
}

// ─── Recent syncs (admin) ───────────────────────────────────────────────

function RecentSyncsCard({
  syncs,
  loading,
}: {
  syncs: CveSyncRunRow[] | undefined;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Recent CVE syncs</CardTitle>
          <Link
            href="/settings/audit"
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            View all
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="rounded-md border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
            Loading…
          </div>
        )}
        {!loading && (!syncs || syncs.length === 0) && (
          <div className="rounded-md border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
            No CVE syncs yet — kick one off from the header.
          </div>
        )}
        {!loading && syncs && syncs.length > 0 && (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {syncs.map((s) => (
              <SyncRow key={s.id} sync={s} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SyncRow({ sync }: { sync: CveSyncRunRow }) {
  const when = sync.finishedAt ?? sync.startedAt;
  const statusColor =
    sync.status === "success"
      ? "text-emerald-500"
      : sync.status === "failed"
        ? "text-red-500"
        : "text-amber-500";
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-wider",
            statusColor
          )}
        >
          {sync.status}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {timeAgo(when)}
        </span>
      </div>
      <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {sync.vulnsDiscovered} vulns / {sync.hostsAffected} hosts ·{" "}
        <span className="text-foreground">{sync.newVulns} new</span>
      </div>
    </div>
  );
}
