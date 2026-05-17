"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Loader2, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/fetcher";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type {
  CleanupResult,
  CollectorConfigAdmin,
  CollectorConfigBools,
  CollectorConfigInts,
  CollectorConfigNullableInts,
} from "@/lib/types";

/**
 * Admin → Collector config.
 *
 * Single page, single Save button. Visual style matches the rest of the
 * admin surface — sharp corners, dense rows, mono for stable identifiers.
 *
 * The "Always-on essentials" group is rendered as visually-disabled
 * Switches so operators can see what the agent ALWAYS gathers — these
 * are not yet toggleable here (OS packages + host metadata are the
 * foundation everything else hangs off of).
 *
 * Rows tagged with `notYetImplemented` get an "agent pending" badge —
 * reserved for features whose collector UI ships before the agent-side
 * helper does. As of agent 1.2.0 there are none, but the affordance
 * stays in place for the next round of feature flags.
 */

interface FeatureRow {
  /** camelCase Prisma column name. */
  field: keyof CollectorConfigBools;
  label: string;
  description: string;
  /** Visually disabled — shown for context, not toggleable. */
  alwaysOn?: boolean;
  /** Agent-side helper not yet implemented. */
  notYetImplemented?: boolean;
}

interface FeatureGroup {
  title: string;
  caption?: string;
  rows: FeatureRow[];
}

const GROUPS: FeatureGroup[] = [
  {
    title: "Essentials",
    caption:
      "Core inventory. Always collected — these are the foundation every other view depends on.",
    rows: [
      {
        field: "collectOsPackages",
        label: "OS packages",
        description:
          "Native packages from dpkg / rpm / apk / pacman. The default inventory; package search and host detail pages rely on it.",
        alwaysOn: true,
      },
    ],
  },
  {
    title: "Optional inventories",
    rows: [
      {
        field: "collectIpAddresses",
        label: "IP addresses",
        description:
          "All global-scope IPv4 addresses per interface. Used for the host list's private IP column and for matching hosts across DNS records.",
      },
      {
        field: "collectServices",
        label: "Running services",
        description:
          "Running systemd units. Useful for spotting services that should be off (e.g. development databases on production hosts).",
      },
      {
        field: "collectListeners",
        label: "Listening ports",
        description:
          "TCP/UDP sockets in LISTEN state via ss / netstat. The fastest way to find unexpected exposure.",
      },
      {
        field: "collectContainers",
        label: "Docker containers",
        description:
          "Running container IDs, image references, and names. No-op on hosts without Docker.",
      },
      {
        field: "collectLanguagePackages",
        label: "Language packages",
        description:
          "Globally-installed pip / npm / gem / composer / cargo packages. System-wide only — never per-project, never node_modules sweeps.",
      },
    ],
  },
  {
    title: "Security & posture",
    caption:
      "Opt-in checks. Default off so older agents (≤ 1.0.x) don't ship empty fields; enable once your fleet is on agent ≥ 1.1.0.",
    rows: [
      {
        field: "collectKernelMitigations",
        label: "Kernel mitigations",
        description:
          "Active CPU vulnerability mitigations from /sys/devices/system/cpu/vulnerabilities. Tells you which Meltdown / Spectre / MDS mitigations are armed.",
      },
      {
        field: "collectLoadedModules",
        label: "Loaded kernel modules",
        description:
          "Currently-loaded modules from /proc/modules. Useful for spotting out-of-tree drivers and unexpected modules.",
      },
      {
        field: "collectPendingUpdates",
        label: "Pending updates",
        description:
          "Upgradable packages per host (apt / dnf / apk / pacman). Shows fleet-wide patch debt at a glance. Reads the local package cache — does not refresh from network.",
      },
      {
        field: "collectContainerRuntime",
        label: "Container runtime",
        description:
          "Installed container runtimes and versions (docker / podman / containerd / crio). Cheap to gather; useful when triaging container-layer incidents.",
      },
      {
        field: "collectVirtualization",
        label: "Virtualization",
        description:
          "Hypervisor / cloud detection via systemd-detect-virt with DMI fallback. Distinguishes bare metal, KVM, EC2, GCE, etc.",
      },
      {
        field: "collectUptime",
        label: "Uptime",
        description:
          "Seconds since last boot, plus boot time. Flags hosts that haven't been rebooted to pick up a kernel update.",
      },
    ],
  },
  {
    title: "Alternate package managers",
    caption:
      "Snap and Flatpak inventories. Default off so older agents (≤ 1.1.x) don't ship empty fields; enable once your fleet is on agent ≥ 1.2.0.",
    rows: [
      {
        field: "collectSnapPackages",
        label: "Snap packages",
        description:
          "Installed snaps via snap list. No-op on hosts without snapd.",
      },
      {
        field: "collectFlatpakPackages",
        label: "Flatpak packages",
        description:
          "Installed flatpaks via flatpak list. Mainly desktop hosts; rare on servers.",
      },
    ],
  },
];

type Local = CollectorConfigBools &
  CollectorConfigInts &
  CollectorConfigNullableInts;

function toLocal(cfg: CollectorConfigAdmin): Local {
  const {
    version: _v,
    updatedAt: _u,
    lastCleanupAt: _l,
    ...rest
  } = cfg;
  return rest;
}

function diff(base: Local, current: Local): Partial<Local> {
  const out: Partial<Local> = {};
  (Object.keys(current) as Array<keyof Local>).forEach((k) => {
    if (base[k] !== current[k]) {
      // Discriminated assignment keeps TS happy across the union type.
      (out as Record<string, unknown>)[k] = current[k];
    }
  });
  return out;
}

export default function CollectorConfigPage() {
  const { data, mutate, isLoading, error } = useSWR<CollectorConfigAdmin>(
    "/api/admin/collector-config",
    jsonFetcher
  );

  const [local, setLocal] = useState<Local | null>(null);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  /**
   * Preserved value for the "Forget inactive hosts after N days" input
   * while the toggle is OFF. Keeps the number visible (greyed) so the
   * operator doesn't have to retype it when re-enabling. Defaults to
   * the server value on hydrate, or 90 as a sensible suggestion if the
   * feature has never been enabled.
   */
  const [inactiveDraft, setInactiveDraft] = useState<number>(90);

  // Hydrate local form state from the server snapshot on first load and
  // after every successful save.
  useEffect(() => {
    if (!data) return;
    setLocal(toLocal(data));
    if (data.inactiveHostRetentionDays != null) {
      setInactiveDraft(data.inactiveHostRetentionDays);
    }
  }, [data]);

  const dirty = useMemo(() => {
    if (!data || !local) return false;
    return Object.keys(diff(toLocal(data), local)).length > 0;
  }, [data, local]);

  // Cross-field validation for the staleness thresholds. Must be
  // positive integers with red strictly greater than amber, or Save
  // is blocked and the inputs get an inline error.
  const thresholdError = useMemo<string | null>(() => {
    if (!local) return null;
    const a = local.staleHostAmberDays;
    const r = local.staleHostRedDays;
    if (!Number.isInteger(a) || a < 1) return "Amber days must be a positive integer.";
    if (!Number.isInteger(r) || r < 1) return "Red days must be a positive integer.";
    if (r <= a) return "Red days must be greater than amber days.";
    return null;
  }, [local]);

  // Validation for the retention block:
  //   • reportRetentionDays must be a positive integer
  //   • when enabled, inactiveHostRetentionDays must be >= report
  const retentionError = useMemo<string | null>(() => {
    if (!local) return null;
    const rep = local.reportRetentionDays;
    if (!Number.isInteger(rep) || rep < 1) {
      return "Report retention must be a positive integer.";
    }
    const inact = local.inactiveHostRetentionDays;
    if (inact != null) {
      if (!Number.isInteger(inact) || inact < 1) {
        return "Inactive host retention must be a positive integer.";
      }
      if (inact < rep) {
        return "Inactive host retention must be at least the report retention.";
      }
    }
    return null;
  }, [local]);

  const setBool = (field: keyof CollectorConfigBools, value: boolean) => {
    setLocal((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  const setInt = (field: keyof CollectorConfigInts, value: number) => {
    setLocal((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  /**
   * Set a nullable-int field. `null` clears it (disable the feature).
   * Used by the "Forget inactive hosts" toggle row.
   */
  const setNullableInt = (
    field: keyof CollectorConfigNullableInts,
    value: number | null
  ) => {
    setLocal((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  const runCleanupNow = async () => {
    setCleaning(true);
    try {
      const res = await fetch("/api/admin/collector-config/cleanup", {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(err?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      const result = (await res.json()) as CleanupResult;
      toast.success(
        `Deleted ${result.reportsDeleted} reports and ${result.hostsDeleted} hosts.`
      );
      // Pull the fresh config so the "Last cleanup" timestamp updates.
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "cleanup failed");
    } finally {
      setCleaning(false);
    }
  };

  const save = async () => {
    if (!data || !local) return;
    if (thresholdError || retentionError) return;
    const body = diff(toLocal(data), local);
    if (Object.keys(body).length === 0) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/collector-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(err?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      const next = (await res.json()) as CollectorConfigAdmin;
      await mutate(next, { revalidate: false });
      toast.success(`Saved. Now at version ${next.version}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight">
          Collector config
        </h3>
        <p className="text-xs text-muted-foreground">
          What the{" "}
          <span className="font-mono">software-inventory.sh</span> agent
          gathers on every cron tick. Changes apply to the whole fleet on
          the next agent run.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error instanceof Error ? error.message : "failed to load"}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
            What agents collect
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {isLoading || !local ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : (
            GROUPS.map((group) => (
              <section key={group.title} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1 border-b pb-2">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.title}
                  </h3>
                  {group.caption && (
                    <p className="text-[11px] text-muted-foreground">
                      {group.caption}
                    </p>
                  )}
                </div>
                <div className="flex flex-col divide-y rounded-md border">
                  {group.rows.map((row) => (
                    <ToggleRow
                      key={row.field}
                      row={row}
                      value={local[row.field]}
                      onChange={(v) => setBool(row.field, v)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}

          {local && (
            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-1 border-b pb-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Host status thresholds
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  How fresh is fresh? Hosts get a green dot until amber-days
                  have passed since their last report, and turn red after
                  red-days.
                </p>
              </div>
              <div className="flex flex-col divide-y rounded-md border">
                <ThresholdRow
                  label="Amber after"
                  description="Hosts that have not reported within this many days show an amber dot in the host list."
                  value={local.staleHostAmberDays}
                  invalid={!!thresholdError}
                  onChange={(v) => setInt("staleHostAmberDays", v)}
                />
                <ThresholdRow
                  label="Red after"
                  description="Hosts silent for this many days show a red dot. Must be greater than the amber threshold."
                  value={local.staleHostRedDays}
                  invalid={!!thresholdError}
                  onChange={(v) => setInt("staleHostRedDays", v)}
                />
              </div>
              {thresholdError && (
                <p className="text-[11px] text-destructive">
                  {thresholdError}
                </p>
              )}
            </section>
          )}

          {local && (
            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-1 border-b pb-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Data retention
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  Automatic cleanup runs after every ingest, throttled to
                  once per 24 hours. Use{" "}
                  <span className="font-medium text-foreground">
                    Run cleanup now
                  </span>{" "}
                  to trigger manually.
                </p>
              </div>
              <div className="flex flex-col divide-y rounded-md border">
                <ThresholdRow
                  label="Keep raw reports for"
                  description="Per-report archive used for forensics. Older reports are deleted on cleanup."
                  value={local.reportRetentionDays}
                  invalid={
                    !Number.isInteger(local.reportRetentionDays) ||
                    local.reportRetentionDays < 1
                  }
                  onChange={(v) => setInt("reportRetentionDays", v)}
                />
                <InactiveHostRow
                  enabled={local.inactiveHostRetentionDays != null}
                  value={
                    local.inactiveHostRetentionDays ?? inactiveDraft
                  }
                  invalid={
                    local.inactiveHostRetentionDays != null &&
                    (!Number.isInteger(local.inactiveHostRetentionDays) ||
                      local.inactiveHostRetentionDays < 1 ||
                      local.inactiveHostRetentionDays <
                        local.reportRetentionDays)
                  }
                  onToggle={(on) => {
                    if (on) {
                      setNullableInt(
                        "inactiveHostRetentionDays",
                        inactiveDraft
                      );
                    } else {
                      // Preserve the current value into the draft so
                      // re-enabling restores it. Then send `null` on PUT.
                      const cur = local.inactiveHostRetentionDays;
                      if (cur != null) setInactiveDraft(cur);
                      setNullableInt("inactiveHostRetentionDays", null);
                    }
                  }}
                  onChange={(v) => {
                    setInactiveDraft(v);
                    setNullableInt("inactiveHostRetentionDays", v);
                  }}
                />
              </div>
              {retentionError && (
                <p className="text-[11px] text-destructive">
                  {retentionError}
                </p>
              )}
              <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">
                  Last cleanup:{" "}
                  <span className="font-mono text-foreground">
                    {data?.lastCleanupAt
                      ? timeAgo(data.lastCleanupAt)
                      : "Never run yet"}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={runCleanupNow}
                  disabled={cleaning}
                >
                  {cleaning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  Run cleanup now
                </Button>
              </div>
            </section>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/30 px-4 py-3">
        <div className="text-[11px] text-muted-foreground">
          {data ? (
            <>
              Version{" "}
              <span className="font-mono text-foreground">{data.version}</span>{" "}
              · last updated{" "}
              <span className="font-mono text-foreground">
                {timeAgo(data.updatedAt)}
              </span>
            </>
          ) : (
            <>—</>
          )}
        </div>
        <Button
          onClick={save}
          disabled={
            saving || !dirty || !!thresholdError || !!retentionError
          }
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save changes
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({
  row,
  value,
  onChange,
}: {
  row: FeatureRow;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const disabled = !!row.alwaysOn;
  return (
    <div className="flex items-start gap-4 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">
            {row.label}
          </span>
          {row.alwaysOn && (
            <span className="rounded-sm border bg-background px-1 py-[1px] font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              always on
            </span>
          )}
          {row.notYetImplemented && (
            <span
              title="Toggle persists, but the agent helper for this feature isn't implemented yet."
              className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1 py-[1px] font-mono text-[9px] uppercase tracking-wider text-amber-700 dark:text-amber-300"
            >
              agent pending
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {row.description}
        </p>
      </div>
      <Toggle
        checked={value}
        disabled={disabled}
        onChange={onChange}
        label={row.label}
      />
    </div>
  );
}

/**
 * Number-input row for the staleness day thresholds. Matches the dense
 * spacing of `ToggleRow` so the new section reads as part of the same
 * settings grid. `invalid` paints the input red when the cross-field
 * constraint (red > amber, both positive) fails.
 */
function ThresholdRow({
  label,
  description,
  value,
  invalid,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  invalid: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-start gap-4 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">{label}</span>
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={1}
          step={1}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange(Number.isNaN(n) ? 0 : n);
          }}
          aria-label={label}
          aria-invalid={invalid}
          className={cn(
            "h-8 w-20 text-right font-mono text-xs",
            invalid && "border-destructive focus-visible:ring-destructive"
          )}
        />
        <span className="text-[11px] text-muted-foreground">days</span>
      </div>
    </div>
  );
}

/**
 * Toggle + number input row for "Forget inactive hosts after N days".
 * When disabled, the input is greyed out and value is preserved
 * (rendered from the parent's draft state) but `null` is sent on PUT.
 */
function InactiveHostRow({
  enabled,
  value,
  invalid,
  onToggle,
  onChange,
}: {
  enabled: boolean;
  value: number;
  invalid: boolean;
  onToggle: (on: boolean) => void;
  onChange: (next: number) => void;
}) {
  const label = "Forget inactive hosts after";
  return (
    <div className="flex items-start gap-4 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">{label}</span>
          {!enabled && (
            <span className="rounded-sm border bg-background px-1 py-[1px] font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              disabled
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          When enabled, hosts that stop reporting will be fully deleted
          along with their package history. Disabled by default — enable
          once you&apos;re sure you don&apos;t need to revive missing hosts.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Toggle
          checked={enabled}
          onChange={onToggle}
          label="Forget inactive hosts toggle"
        />
        <Input
          type="number"
          min={1}
          step={1}
          value={Number.isFinite(value) ? value : ""}
          disabled={!enabled}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange(Number.isNaN(n) ? 0 : n);
          }}
          aria-label="Inactive host retention days"
          aria-invalid={invalid}
          className={cn(
            "h-8 w-20 text-right font-mono text-xs",
            !enabled && "opacity-50",
            invalid && "border-destructive focus-visible:ring-destructive"
          )}
        />
        <span className="text-[11px] text-muted-foreground">days</span>
      </div>
    </div>
  );
}

/**
 * Minimal Tailwind toggle. We don't depend on @radix-ui/react-switch
 * yet, and a single boolean toggle doesn't earn a new dependency. Keyboard
 * accessible (space + enter), focus-visible ring, ARIA switch role.
 */
function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-md border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        disabled && "cursor-not-allowed opacity-50",
        checked
          ? "border-primary bg-primary"
          : "border-input bg-muted"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-3.5 w-3.5 transform rounded-sm bg-background shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        )}
      />
    </button>
  );
}
