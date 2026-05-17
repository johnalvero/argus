"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { jsonFetcher } from "@/lib/fetcher";
import { timeAgo } from "@/lib/utils";
import type { CveSyncRunRow } from "@/lib/types";

/**
 * Header-mounted "Sync CVEs" trigger + status pill (admin only).
 *
 * Three visible states:
 *   • idle    — ShieldCheck icon + "Sync CVEs" + small "last: 3h ago"
 *               caption (or "never"). Caption hidden < sm.
 *   • running — spinner + "Syncing…", button disabled.
 *   • done    — green check + "Synced", auto-fades back to idle 30s
 *               after the run finishes.
 *
 * Polling: SWR holds the run list. When `status === "running"` on the
 * latest row, we drop the refresh interval to 3s; otherwise we keep
 * a slow 60s heartbeat so the timeAgo caption stays roughly fresh.
 *
 * Toast on completion fires on the running→success/failed transition,
 * keyed off the latest row's id so a second sync gets its own toast.
 */

interface Props {
  isAdmin: boolean;
}

const SLOW_POLL_MS = 60_000;
const FAST_POLL_MS = 3_000;
const SUCCESS_FLASH_MS = 30_000;

export function CveSyncButton({ isAdmin }: Props) {
  const { data, mutate, isLoading } = useSWR<CveSyncRunRow[]>(
    isAdmin ? "/api/admin/cve/sync" : null,
    jsonFetcher,
    {
      refreshInterval: (latest) => {
        if (!latest || latest.length === 0) return SLOW_POLL_MS;
        return latest[0]!.status === "running" ? FAST_POLL_MS : SLOW_POLL_MS;
      },
      revalidateOnFocus: true,
    }
  );

  const [submitting, setSubmitting] = useState(false);
  const [showFlash, setShowFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track which run id we last toasted on so we don't fire twice on
  // re-renders while the row keeps its terminal status.
  const lastToastedId = useRef<number | null>(null);

  // Hide caption pre-mount to avoid hydration mismatch on timeAgo().
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const latest = data?.[0] ?? null;
  const running = latest?.status === "running";
  const latestFinished = data?.find((r) => r.status !== "running") ?? null;

  // Watch for running→terminal transitions to toast + flash.
  useEffect(() => {
    if (!latest) return;
    if (latest.status === "running") return;
    if (lastToastedId.current === latest.id) return;
    // On first mount with a pre-existing finished run, don't toast that
    // historical run — only toast for runs we observed transition.
    if (lastToastedId.current === null) {
      lastToastedId.current = latest.id;
      return;
    }
    lastToastedId.current = latest.id;
    if (latest.status === "success") {
      toast.success(
        `Sync complete: ${latest.vulnsDiscovered} vulnerabilities affecting ${latest.hostsAffected} hosts (${latest.newVulns} new).`
      );
    } else {
      toast.error(
        `Sync failed${latest.error ? `: ${latest.error}` : ""}`
      );
    }
    setShowFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      setShowFlash(false);
    }, SUCCESS_FLASH_MS);
  }, [latest]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  if (!isAdmin) return null;

  const onClick = async () => {
    if (running || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/cve/sync", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
      }
      // Force a refresh so polling kicks in at 3s immediately.
      await mutate();
    } catch (err) {
      toast.error(
        `Failed to start sync: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSubmitting(false);
    }
  };

  const lastLabel = (() => {
    if (!mounted) return null;
    if (isLoading && !latestFinished) return null;
    if (!latestFinished) return "never";
    if (!latestFinished.finishedAt) return "never";
    return timeAgo(latestFinished.finishedAt);
  })();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={running || submitting}
      title={running ? "Sync in progress" : "Sync CVE data from osv.dev"}
      aria-label="Sync CVEs"
      className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
    >
      {running || submitting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : showFlash && latest?.status === "success" ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <ShieldCheck className="h-3.5 w-3.5" />
      )}
      <span className="text-xs">
        {running || submitting
          ? "Syncing…"
          : showFlash && latest?.status === "success"
          ? "Synced"
          : "Sync CVEs"}
      </span>
      {!running && !submitting && !showFlash && lastLabel && (
        <span className="hidden text-[10px] text-muted-foreground/70 sm:inline">
          last: {lastLabel}
        </span>
      )}
    </Button>
  );
}
