"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/utils";
import type {
  NotificationListResponse,
  NotificationRow,
  NotificationSeverity,
} from "@/lib/types";

/**
 * Header notification bell. Shows the running unread count, opens a
 * dropdown panel of the most recent 20 notifications, and routes to
 * the full /notifications page via "See all".
 *
 * Polls /api/notifications?limit=20 every 30s. The unread count is
 * computed server-side over the full set so it stays accurate even
 * when the dropdown shows only the most recent slice.
 */

const REFRESH_MS = 30_000;
const PANEL_LIMIT = 20;

const SEVERITY_DOT_COLOR: Record<NotificationSeverity, string> = {
  critical: "#ef4444",
  warning: "#f59e0b",
  info: "#3b82f6",
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const { data, mutate, isLoading } = useSWR<NotificationListResponse>(
    `/api/notifications?limit=${PANEL_LIMIT}`,
    jsonFetcher,
    {
      refreshInterval: REFRESH_MS,
      revalidateOnFocus: true,
    }
  );

  // Click-outside + Escape to close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = data?.unreadCount ?? 0;
  const items = data?.items ?? [];

  const markRead = async (id: number) => {
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: "POST",
        credentials: "same-origin",
      });
      await mutate();
    } catch {
      /* non-critical — read state is best-effort */
    }
  };

  const markAllRead = async () => {
    try {
      const res = await fetch("/api/notifications/read-all", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await mutate();
      toast.success("All notifications marked read");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "could not mark all read"
      );
    }
  };

  const handleRowClick = async (n: NotificationRow) => {
    await markRead(n.id);
    setOpen(false);
    if (n.href) router.push(n.href);
  };

  const badge =
    unread === 0 ? null : unread > 9 ? "9+" : String(unread);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        className={cn(
          "relative inline-flex h-8 items-center justify-center rounded-md px-2 text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
      >
        <Bell className="h-4 w-4" />
        {badge && (
          <span
            className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-mono text-[9px] font-bold leading-none text-destructive-foreground"
            aria-hidden="true"
          >
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-50 w-[360px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-semibold">Notifications</span>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unread === 0}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              Mark all read
            </button>
          </div>

          <div className="max-h-[400px] overflow-y-auto">
            {isLoading && items.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                Loading…
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
                No notifications yet — set up a Watchlist.
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  role="menuitem"
                  type="button"
                  onClick={() => handleRowClick(n)}
                  className={cn(
                    "flex w-full items-start gap-2 border-b px-3 py-2 text-left transition-colors last:border-b-0",
                    n.isRead
                      ? "bg-transparent hover:bg-accent/40"
                      : "bg-accent/20 hover:bg-accent/40"
                  )}
                >
                  <span
                    className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: SEVERITY_DOT_COLOR[n.severity],
                    }}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={cn(
                          "truncate text-xs",
                          n.isRead
                            ? "font-normal text-muted-foreground"
                            : "font-semibold text-foreground"
                        )}
                      >
                        {n.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {timeAgo(n.createdAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {n.body}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="border-t px-3 py-2 text-right">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              See all
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
