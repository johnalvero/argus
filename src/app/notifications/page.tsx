"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Bell, Check, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/fetcher";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type {
  NotificationListResponse,
  NotificationRow,
  NotificationSeverity,
  WatchlistRow,
} from "@/lib/types";

/**
 * Full notifications page. Filter by read/unread + by watchlist.
 *
 * Pagination is virtual — we ask for `pageSize × (page+1)` and slice.
 * The API caps `limit` at 200 which is plenty for the volumes Argus
 * generates; a real cursor-based scheme can land later when somebody
 * actually hits the cap.
 */

const PAGE_SIZE = 50;

const SEVERITY_DOT_COLOR: Record<NotificationSeverity, string> = {
  critical: "#ef4444",
  warning: "#f59e0b",
  info: "#3b82f6",
};

type ReadFilter = "all" | "unread";

export default function NotificationsPage() {
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [watchlistId, setWatchlistId] = useState<number | null>(null);
  const [page, setPage] = useState(1);

  // Watchlists for the filter dropdown — admin-only endpoint, gracefully
  // empty for non-admins.
  const { data: watchlists } = useSWR<WatchlistRow[]>(
    "/api/admin/watchlists",
    jsonFetcher,
    { shouldRetryOnError: false }
  );

  const limit = page * PAGE_SIZE;
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (readFilter === "unread") qs.set("unread", "1");
  if (watchlistId) qs.set("watchlistId", String(watchlistId));

  const { data, mutate, isLoading } = useSWR<NotificationListResponse>(
    `/api/notifications?${qs.toString()}`,
    jsonFetcher,
    { refreshInterval: 30_000 }
  );

  const markRead = async (id: number) => {
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
      await mutate();
    } catch {
      /* best-effort */
    }
  };

  const markAllRead = async () => {
    try {
      const res = await fetch("/api/notifications/read-all", {
        method: "POST",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await mutate();
      toast.success("All notifications marked read");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "failed");
    }
  };

  const items = data?.items ?? [];
  const hasMore = items.length === limit;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Bell className="h-5 w-5 text-muted-foreground" />
          Notifications
        </h2>
        <p className="text-sm text-muted-foreground">
          {data?.unreadCount ?? 0} unread.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <span>Inbox</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <select
              value={readFilter}
              onChange={(e) => {
                setReadFilter(e.target.value as ReadFilter);
                setPage(1);
              }}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="all">All</option>
              <option value="unread">Unread only</option>
            </select>
            <select
              value={watchlistId ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setWatchlistId(v ? Number(v) : null);
                setPage(1);
              }}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="">All watchlists</option>
              {(watchlists ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={markAllRead}
              disabled={(data?.unreadCount ?? 0) === 0}
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && items.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Loading…
            </div>
          )}
          {!isLoading && items.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Nothing to show.
            </div>
          )}
          <div className="flex flex-col gap-1">
            {items.map((n) => (
              <NotificationItem
                key={n.id}
                n={n}
                onRead={() => markRead(n.id)}
              />
            ))}
          </div>
          {hasMore && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
              >
                Load more
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NotificationItem({
  n,
  onRead,
}: {
  n: NotificationRow;
  onRead: () => void;
}) {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    n.href ? (
      <Link
        href={n.href}
        onClick={onRead}
        className="block focus-visible:outline-none"
      >
        {children}
      </Link>
    ) : (
      <div>{children}</div>
    );
  return (
    <Wrapper>
      <div
        className={cn(
          "flex items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
          n.isRead
            ? "bg-background hover:bg-accent/30"
            : "bg-accent/20 hover:bg-accent/40"
        )}
      >
        <span
          className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: SEVERITY_DOT_COLOR[n.severity] }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                "truncate text-sm",
                n.isRead
                  ? "font-normal text-muted-foreground"
                  : "font-semibold text-foreground"
              )}
            >
              {n.title}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {timeAgo(n.createdAt)}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {n.body}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="muted" className="text-[10px]">
              {n.watchlistName}
            </Badge>
            {n.emailedAt && (
              <Badge variant="success" className="text-[10px]">
                emailed
              </Badge>
            )}
            {n.emailError && (
              <Badge variant="destructive" className="text-[10px]">
                email failed
              </Badge>
            )}
          </div>
        </div>
        {!n.isRead && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRead();
            }}
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
            title="Mark read"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </Wrapper>
  );
}
