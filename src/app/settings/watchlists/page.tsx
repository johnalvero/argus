"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import {
  Bell,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TagChip } from "@/components/TagChip";
import type {
  NotificationChannel,
  TagAdmin,
  WatchlistKind,
  WatchlistRow,
  WatchlistSpec,
} from "@/lib/types";

/**
 * Admin → Watchlists.
 *
 * Table of saved rules with enable toggle, eval-now, edit, delete.
 * Create + edit happen in a three-step dialog: basics → spec → channels.
 */

const ECOSYSTEMS = ["os", "pip", "npm", "gem", "composer", "cargo"];
const MIN_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

interface EditorState {
  id: number | null;
  step: 1 | 2 | 3;
  name: string;
  description: string;
  enabled: boolean;
  kind: WatchlistKind;
  // Spec scratch — flat fields per kind. We assemble the discriminated
  // union on submit.
  vulnMinSeverity: "" | (typeof MIN_SEVERITIES)[number];
  vulnEcosystems: string[];
  vulnTagIds: number[];
  pkgName: string;
  pkgVersion: string;
  pkgEcosystem: string;
  driftInactiveDays: number;
  driftTagIds: number[];
  channels: NotificationChannel[];
  recipients: string;
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  step: 1,
  name: "",
  description: "",
  enabled: true,
  kind: "vulnerability",
  vulnMinSeverity: "CRITICAL",
  vulnEcosystems: [],
  vulnTagIds: [],
  pkgName: "",
  pkgVersion: "",
  pkgEcosystem: "",
  driftInactiveDays: 7,
  driftTagIds: [],
  channels: ["inapp"],
  recipients: "",
};

export default function WatchlistsSettingsPage() {
  const { data, mutate, isLoading, error } = useSWR<WatchlistRow[]>(
    "/api/admin/watchlists",
    jsonFetcher
  );
  const { data: tags } = useSWR<TagAdmin[]>("/api/admin/tags", jsonFetcher);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<WatchlistRow | null>(null);
  const [evaluating, setEvaluating] = useState<number | null>(null);

  const openCreate = () => setEditor({ ...EMPTY_EDITOR });
  const openEdit = (w: WatchlistRow) => {
    const e: EditorState = { ...EMPTY_EDITOR, id: w.id, step: 1 };
    e.name = w.name;
    e.description = w.description ?? "";
    e.enabled = w.enabled;
    e.kind = w.kind;
    if (w.spec.kind === "vulnerability") {
      e.vulnMinSeverity = w.spec.minSeverity ?? "";
      e.vulnEcosystems = w.spec.ecosystem ?? [];
      e.vulnTagIds = w.spec.tagIds ?? [];
    } else if (w.spec.kind === "package") {
      e.pkgName = w.spec.name;
      e.pkgVersion = w.spec.version ?? "";
      e.pkgEcosystem = w.spec.ecosystem ?? "";
    } else if (w.spec.kind === "host_drift") {
      e.driftInactiveDays = w.spec.inactiveDays;
      e.driftTagIds = w.spec.tagIds ?? [];
    }
    e.channels = w.channels;
    e.recipients = (w.recipients ?? []).join(", ");
    setEditor(e);
  };

  const toggleEnabled = async (w: WatchlistRow) => {
    try {
      const res = await fetch(`/api/admin/watchlists/${w.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !w.enabled }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "update failed");
    }
  };

  const evaluateNow = async (w: WatchlistRow) => {
    setEvaluating(w.id);
    try {
      const res = await fetch(`/api/admin/watchlists/${w.id}/evaluate`, {
        method: "POST",
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? `${res.status}`);
      }
      const b = (await res.json()) as { evaluated: number; triggered: number };
      toast.success(
        `Evaluated ${b.evaluated} watchlist${b.evaluated === 1 ? "" : "s"} — ${b.triggered} new notification${b.triggered === 1 ? "" : "s"}`
      );
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "evaluation failed");
    } finally {
      setEvaluating(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight">Watchlists</h3>
        <p className="text-xs text-muted-foreground">
          Saved rules. Matches generate in-app notifications and (when
          opted in) emails via SES. Triggered after CVE sync and after
          each host report.
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
            <Bell className="h-4 w-4 text-muted-foreground" />
            All watchlists
            <span className="font-normal text-muted-foreground">
              ({data?.length ?? 0})
            </span>
          </CardTitle>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-3.5 w-3.5" /> Create watchlist
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Channels</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">7d</TableHead>
                <TableHead>Last eval</TableHead>
                <TableHead className="w-[160px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-xs text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && (data?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-xs text-muted-foreground"
                  >
                    No watchlists yet. Create one to start receiving
                    notifications.
                  </TableCell>
                </TableRow>
              )}
              {data?.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span
                        className={cn(
                          "text-xs font-medium",
                          !w.enabled && "text-muted-foreground line-through"
                        )}
                      >
                        {w.name}
                      </span>
                      {w.description && (
                        <span className="text-[10px] text-muted-foreground">
                          {w.description}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="muted" className="font-mono text-[10px]">
                      {w.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {w.channels.map((c) => (
                        <Badge
                          key={c}
                          variant={c === "email" ? "info" : "secondary"}
                          className="text-[10px]"
                        >
                          {c}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {w.matchCount}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {w.recentNotificationCount}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {w.lastEvaluatedAt ? timeAgo(w.lastEvaluatedAt) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleEnabled(w)}
                        title={w.enabled ? "Disable" : "Enable"}
                      >
                        <span className="text-[10px]">
                          {w.enabled ? "On" : "Off"}
                        </span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => evaluateNow(w)}
                        disabled={evaluating === w.id}
                        title="Evaluate now"
                      >
                        {evaluating === w.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Play className="h-3 w-3" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(w)}
                        title="Edit"
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleting(w)}
                        title="Delete"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <WatchlistEditorDialog
        state={editor}
        tags={tags ?? []}
        onChange={setEditor}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          mutate();
        }}
      />

      <DeleteDialog
        watchlist={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          mutate();
        }}
      />
    </div>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────
function WatchlistEditorDialog({
  state,
  tags,
  onChange,
  onClose,
  onSaved,
}: {
  state: EditorState | null;
  tags: TagAdmin[];
  onChange: (s: EditorState | null) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);

  // Reset step to 1 whenever a different watchlist is opened.
  const editorKey = state ? `${state.id ?? "new"}` : null;
  useEffect(() => {
    if (state && state.step !== 1) {
      onChange({ ...state, step: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey]);

  if (!state) {
    return (
      <Dialog open={false} onOpenChange={() => onClose()}>
        <DialogContent />
      </Dialog>
    );
  }
  const isEdit = state.id != null;

  const update = (patch: Partial<EditorState>) =>
    onChange({ ...state, ...patch });

  const submit = async () => {
    setSaving(true);
    try {
      const spec = buildSpec(state);
      if (!spec.ok) {
        toast.error(spec.error);
        return;
      }
      const recipients = state.recipients
        .split(/[,\n\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const body = {
        name: state.name.trim(),
        description: state.description.trim() || null,
        enabled: state.enabled,
        kind: state.kind,
        spec: spec.value,
        channels: state.channels,
        recipients: recipients.length > 0 ? recipients : null,
      };
      const url = isEdit
        ? `/api/admin/watchlists/${state.id}`
        : "/api/admin/watchlists";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(b?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      toast.success(isEdit ? "Watchlist updated" : "Watchlist created");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  const canNext = (() => {
    if (state.step === 1) return state.name.trim().length > 0;
    if (state.step === 2) {
      if (state.kind === "package") return state.pkgName.trim().length > 0;
      if (state.kind === "host_drift") return state.driftInactiveDays > 0;
      return true;
    }
    return true;
  })();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit watchlist" : "Create watchlist"}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Step {state.step} of 3
            </span>
          </DialogTitle>
          <DialogDescription>
            {state.step === 1 && "Basics — name and rule kind."}
            {state.step === 2 && "Rule specification."}
            {state.step === 3 && "Where and how to notify."}
          </DialogDescription>
        </DialogHeader>

        {state.step === 1 && (
          <Step1 state={state} update={update} />
        )}
        {state.step === 2 && (
          <Step2 state={state} update={update} tags={tags} />
        )}
        {state.step === 3 && (
          <Step3 state={state} update={update} />
        )}

        <DialogFooter className="!justify-between">
          <div>
            {state.step > 1 && (
              <Button
                variant="outline"
                onClick={() =>
                  update({
                    step: (state.step - 1) as EditorState["step"],
                  })
                }
                disabled={saving}
              >
                Back
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            {state.step < 3 ? (
              <Button
                onClick={() =>
                  update({ step: (state.step + 1) as EditorState["step"] })
                }
                disabled={!canNext}
              >
                Next
              </Button>
            ) : (
              <Button onClick={submit} disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isEdit ? "Save changes" : "Create watchlist"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step1({
  state,
  update,
}: {
  state: EditorState;
  update: (p: Partial<EditorState>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="wl-name">Name</Label>
        <Input
          id="wl-name"
          value={state.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="e.g. Critical CVEs on prod"
          maxLength={80}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="wl-desc">
          Description <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="wl-desc"
          value={state.description}
          onChange={(e) => update({ description: e.target.value })}
          maxLength={500}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Kind</Label>
        <div className="flex flex-wrap gap-2">
          {(["vulnerability", "package", "host_drift"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => update({ kind: k })}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs transition-colors",
                state.kind === k
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent"
              )}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Step2({
  state,
  update,
  tags,
}: {
  state: EditorState;
  update: (p: Partial<EditorState>) => void;
  tags: TagAdmin[];
}) {
  if (state.kind === "vulnerability") {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-1.5">
          <Label>Minimum severity</Label>
          <div className="flex flex-wrap gap-2">
            {MIN_SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() =>
                  update({
                    vulnMinSeverity:
                      state.vulnMinSeverity === s ? "" : s,
                  })
                }
                className={cn(
                  "rounded-md border px-3 py-1 text-[11px] font-mono uppercase transition-colors",
                  state.vulnMinSeverity === s
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent"
                )}
              >
                ≥ {s}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label>Ecosystems (any when empty)</Label>
          <div className="flex flex-wrap gap-2">
            {ECOSYSTEMS.map((e) => {
              const active = state.vulnEcosystems.includes(e);
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() =>
                    update({
                      vulnEcosystems: active
                        ? state.vulnEcosystems.filter((x) => x !== e)
                        : [...state.vulnEcosystems, e],
                    })
                  }
                  className={cn(
                    "rounded-md border px-2 py-1 font-mono text-[10px] transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background hover:bg-accent"
                  )}
                >
                  {e}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label>Tags (any when empty)</Label>
          <div className="flex flex-wrap gap-1.5">
            {tags.length === 0 && (
              <span className="text-[11px] text-muted-foreground">
                No tags defined yet.
              </span>
            )}
            {tags.map((t) => (
              <TagChip
                key={t.id}
                tag={t}
                active={state.vulnTagIds.includes(t.id)}
                interactive
                onClick={() =>
                  update({
                    vulnTagIds: state.vulnTagIds.includes(t.id)
                      ? state.vulnTagIds.filter((x) => x !== t.id)
                      : [...state.vulnTagIds, t.id],
                  })
                }
              />
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (state.kind === "package") {
    return (
      <div className="flex flex-col gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="wl-pkg-eco">Ecosystem</Label>
          <select
            id="wl-pkg-eco"
            value={state.pkgEcosystem}
            onChange={(e) => update({ pkgEcosystem: e.target.value })}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">(any)</option>
            {ECOSYSTEMS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wl-pkg-name">Package name</Label>
          <Input
            id="wl-pkg-name"
            value={state.pkgName}
            onChange={(e) => update({ pkgName: e.target.value })}
            placeholder="e.g. openssl, nginx, lodash"
            className="font-mono"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wl-pkg-ver">
            Exact version{" "}
            <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="wl-pkg-ver"
            value={state.pkgVersion}
            onChange={(e) => update({ pkgVersion: e.target.value })}
            placeholder="leave blank to match any version"
            className="font-mono"
          />
        </div>
      </div>
    );
  }
  // host_drift
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="wl-drift-days">Inactive days</Label>
        <Input
          id="wl-drift-days"
          type="number"
          min={1}
          value={state.driftInactiveDays}
          onChange={(e) =>
            update({ driftInactiveDays: Math.max(1, Number(e.target.value) || 1) })
          }
          className="w-28 font-mono"
        />
        <p className="text-[11px] text-muted-foreground">
          Notify when a host's last report is older than this many days.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label>Tags (any when empty)</Label>
        <div className="flex flex-wrap gap-1.5">
          {tags.length === 0 && (
            <span className="text-[11px] text-muted-foreground">
              No tags defined yet.
            </span>
          )}
          {tags.map((t) => (
            <TagChip
              key={t.id}
              tag={t}
              active={state.driftTagIds.includes(t.id)}
              interactive
              onClick={() =>
                update({
                  driftTagIds: state.driftTagIds.includes(t.id)
                    ? state.driftTagIds.filter((x) => x !== t.id)
                    : [...state.driftTagIds, t.id],
                })
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Step3({
  state,
  update,
}: {
  state: EditorState;
  update: (p: Partial<EditorState>) => void;
}) {
  const emailOn = state.channels.includes("email");
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label>Channels</Label>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked disabled className="h-4 w-4" />
            <span>In-app (always on)</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={emailOn}
              onChange={(e) =>
                update({
                  channels: e.target.checked
                    ? (["inapp", "email"] as NotificationChannel[])
                    : (["inapp"] as NotificationChannel[]),
                })
              }
              className="h-4 w-4"
            />
            <span>Email (requires SES configured)</span>
          </label>
        </div>
      </div>
      {emailOn && (
        <div className="grid gap-1.5">
          <Label htmlFor="wl-recipients">
            Recipients{" "}
            <span className="text-muted-foreground">
              (one per line; defaults to your email if blank)
            </span>
          </Label>
          <textarea
            id="wl-recipients"
            value={state.recipients}
            onChange={(e) => update({ recipients: e.target.value })}
            placeholder="alice@example.com&#10;bob@example.com"
            rows={3}
            className="min-h-[80px] w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
          />
        </div>
      )}
      <label className="mt-2 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
          className="h-4 w-4"
        />
        <span>Enabled (evaluate on triggers)</span>
      </label>
    </div>
  );
}

interface BuildSpecOk {
  ok: true;
  value: WatchlistSpec;
}
interface BuildSpecErr {
  ok: false;
  error: string;
}
function buildSpec(s: EditorState): BuildSpecOk | BuildSpecErr {
  if (s.kind === "vulnerability") {
    const spec: WatchlistSpec & { kind: "vulnerability" } = {
      kind: "vulnerability",
    };
    if (s.vulnMinSeverity) spec.minSeverity = s.vulnMinSeverity;
    if (s.vulnEcosystems.length > 0) spec.ecosystem = s.vulnEcosystems;
    if (s.vulnTagIds.length > 0) spec.tagIds = s.vulnTagIds;
    return { ok: true, value: spec };
  }
  if (s.kind === "package") {
    if (!s.pkgName.trim()) {
      return { ok: false, error: "Package name is required" };
    }
    const spec: WatchlistSpec & { kind: "package" } = {
      kind: "package",
      name: s.pkgName.trim(),
    };
    if (s.pkgVersion.trim()) spec.version = s.pkgVersion.trim();
    if (s.pkgEcosystem) spec.ecosystem = s.pkgEcosystem;
    return { ok: true, value: spec };
  }
  if (s.driftInactiveDays < 1) {
    return { ok: false, error: "Inactive days must be ≥ 1" };
  }
  const spec: WatchlistSpec & { kind: "host_drift" } = {
    kind: "host_drift",
    inactiveDays: s.driftInactiveDays,
  };
  if (s.driftTagIds.length > 0) spec.tagIds = s.driftTagIds;
  return { ok: true, value: spec };
}

// ─── Delete ─────────────────────────────────────────────────────────
function DeleteDialog({
  watchlist,
  onClose,
  onDeleted,
}: {
  watchlist: WatchlistRow | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const open = watchlist !== null;
  const remove = async () => {
    if (!watchlist) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/watchlists/${watchlist.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(b?.error ?? `${res.status}`);
      }
      const b = (await res.json()) as { notificationsRemoved: number };
      toast.success(
        `Watchlist deleted (${b.notificationsRemoved} notifications removed)`
      );
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete watchlist</DialogTitle>
          <DialogDescription>
            {watchlist
              ? `Delete "${watchlist.name}"? ${watchlist.matchCount} notifications will cascade.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={remove} disabled={busy}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
