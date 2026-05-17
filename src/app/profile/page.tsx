"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFormatDateTime } from "@/lib/datetime";

/**
 * Curated short list. Operators most often pick one of these; anything
 * else they type in goes through Intl validation server-side. The list
 * is intentionally short — long IANA dropdowns are useless without
 * search, and we'd rather not pull in a combobox library for v1.
 */
const COMMON_ZONES = [
  "UTC",
  "Asia/Manila",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
];

type SettingsResponse = { timezone: string | null };

async function fetchSettings(url: string): Promise<SettingsResponse> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as SettingsResponse;
}

export default function SettingsPage() {
  const { data, isLoading } = useSWR<SettingsResponse>(
    "/api/auth/settings",
    fetchSettings
  );

  const detectedZone = useMemo(() => {
    if (typeof Intl === "undefined") return "UTC";
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const [selection, setSelection] = useState<string>("__auto__");
  const [customZone, setCustomZone] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "ok" | "err";
    message: string;
  } | null>(null);

  // Hydrate selection from server. If the user has a saved zone, pick
  // it; if it's in the curated list, select it directly, otherwise
  // drop it into the custom field.
  useEffect(() => {
    if (!data) return;
    if (data.timezone === null) {
      setSelection("__auto__");
      setCustomZone("");
    } else if (COMMON_ZONES.includes(data.timezone)) {
      setSelection(data.timezone);
      setCustomZone("");
    } else {
      setSelection("__custom__");
      setCustomZone(data.timezone);
    }
  }, [data]);

  const formatDt = useFormatDateTime();
  const now = useMemo(() => new Date(), []);

  const onSave = async () => {
    setFeedback(null);
    let body: { timezone: string | null };
    if (selection === "__auto__") {
      body = { timezone: null };
    } else if (selection === "__custom__") {
      const trimmed = customZone.trim();
      if (!trimmed) {
        setFeedback({ kind: "err", message: "Custom timezone is empty." });
        return;
      }
      body = { timezone: trimmed };
    } else {
      body = { timezone: selection };
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `${res.status} ${res.statusText}`);
      }
      const next = (await res.json()) as SettingsResponse;
      await mutate("/api/auth/settings");
      await mutate("/api/auth/me"); // refresh nav user info incl. zone
      setFeedback({
        kind: "ok",
        message: next.timezone
          ? `Saved. Times will render in ${next.timezone}.`
          : `Saved. Times will follow the browser (${detectedZone}).`,
      });
    } catch (e) {
      setFeedback({
        kind: "err",
        message: e instanceof Error ? e.message : "Failed to save",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Profile</h2>
        <p className="text-sm text-muted-foreground">
          Your personal preferences. Account-wide settings only — fleet
          and admin controls live under Settings.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Display timezone</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            Controls how timestamps render across the dashboard. The
            collector always stores timestamps in UTC; this only changes
            display.
          </p>

          {isLoading ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="tz-select" className="text-xs">
                  Timezone
                </Label>
                <select
                  id="tz-select"
                  value={selection}
                  onChange={(e) => setSelection(e.target.value)}
                  className="rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
                >
                  <option value="__auto__">
                    Browser default ({detectedZone})
                  </option>
                  <optgroup label="Common">
                    {COMMON_ZONES.map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </optgroup>
                  <option value="__custom__">Custom IANA zone…</option>
                </select>
              </div>

              {selection === "__custom__" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="tz-custom" className="text-xs">
                    Custom IANA zone
                  </Label>
                  <Input
                    id="tz-custom"
                    value={customZone}
                    onChange={(e) => setCustomZone(e.target.value)}
                    placeholder="e.g. Pacific/Auckland"
                    className="font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Must be a valid IANA name (
                    <a
                      href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      reference
                    </a>
                    ). The server rejects unknown values.
                  </p>
                </div>
              )}

              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Preview
                </div>
                <div className="mt-1 font-mono">
                  {formatDt(now)}
                </div>
              </div>

              {feedback && (
                <div
                  className={
                    "rounded-md border px-3 py-2 text-xs " +
                    (feedback.kind === "ok"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-destructive/40 bg-destructive/10 text-destructive")
                  }
                >
                  {feedback.message}
                </div>
              )}

              <div className="flex items-center justify-end">
                <Button onClick={onSave} disabled={submitting}>
                  {submitting ? "Saving…" : "Save"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
