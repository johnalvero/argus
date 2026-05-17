"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Loader2, Pencil, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { TagChip, tagChipStyle } from "@/components/TagChip";
import type { TagAdmin } from "@/lib/types";

/**
 * Admin → Tags.
 *
 * Create / edit / delete the tag taxonomy that the rest of the app
 * filters on. The list table is the primary surface; create + edit
 * happen in a small modal so the page state stays calm.
 *
 * Delete confirms with the host-count impact so the operator can't
 * accidentally strip tags from a wide swath of the fleet.
 */

// Curated palette across the standard Tailwind 500-tier hues. The
// custom-hex input is still available; this is just the fast path.
const PALETTE: { name: string; hex: string }[] = [
  { name: "red", hex: "#ef4444" },
  { name: "orange", hex: "#f97316" },
  { name: "amber", hex: "#f59e0b" },
  { name: "emerald", hex: "#10b981" },
  { name: "teal", hex: "#14b8a6" },
  { name: "cyan", hex: "#06b6d4" },
  { name: "blue", hex: "#3b82f6" },
  { name: "violet", hex: "#8b5cf6" },
  { name: "purple", hex: "#a855f7" },
  { name: "pink", hex: "#ec4899" },
  { name: "slate", hex: "#64748b" },
  { name: "zinc", hex: "#71717a" },
];

const DEFAULT_COLOR = PALETTE[6]!.hex; // blue

interface EditorState {
  /** null = creating, number = editing existing tag id. */
  id: number | null;
  name: string;
  color: string;
  description: string;
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  name: "",
  color: DEFAULT_COLOR,
  description: "",
};

interface DeleteState {
  tag: TagAdmin;
}

export default function TagsSettingsPage() {
  const { data, mutate, isLoading, error } = useSWR<TagAdmin[]>(
    "/api/admin/tags",
    jsonFetcher
  );

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<DeleteState | null>(null);

  const openCreate = () => setEditor({ ...EMPTY_EDITOR });
  const openEdit = (tag: TagAdmin) =>
    setEditor({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      description: tag.description ?? "",
    });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight">Tags</h3>
        <p className="text-xs text-muted-foreground">
          First-class tags for slicing the fleet. Used by the host list
          filter, host detail, and (soon) the CVE dashboard / watchlists
          / compliance scorecard.
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
            <TagIcon className="h-4 w-4 text-muted-foreground" />
            All tags
            <span className="text-muted-foreground font-normal">
              ({data?.length ?? 0})
            </span>
          </CardTitle>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-3.5 w-3.5" /> Create tag
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Hosts</TableHead>
                <TableHead className="w-[140px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-xs text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && (data?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-xs text-muted-foreground"
                  >
                    No tags yet. Create one to start segmenting the fleet.
                  </TableCell>
                </TableRow>
              )}
              {data?.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <TagChip tag={t} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {t.hostCount}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(t)}
                        title="Edit"
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleting({ tag: t })}
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

      <TagEditorDialog
        state={editor}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          mutate();
        }}
      />

      <TagDeleteDialog
        state={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          mutate();
        }}
      />
    </div>
  );
}

// ─── Editor (create + edit) ───────────────────────────────────────────
function TagEditorDialog({
  state,
  onClose,
  onSaved,
}: {
  state: EditorState | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset the form whenever the dialog opens against a different
  // tag (or transitions to "create"). The editor key collapses the
  // dependency to "which tag are we editing" so the effect doesn't
  // re-fire on parent re-renders mid-edit.
  const editorKey = state ? `${state.id ?? "new"}` : null;
  useEffect(() => {
    if (state) {
      setName(state.name);
      setColor(state.color);
      setDescription(state.description);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey]);

  const isEdit = state?.id != null;
  const open = state !== null;

  const save = async () => {
    if (!state) return;
    setSaving(true);
    try {
      const url = isEdit ? `/api/admin/tags/${state.id}` : "/api/admin/tags";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          color: color.trim(),
          description: description.trim() === "" ? null : description.trim(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(body?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      toast.success(isEdit ? "Tag updated" : "Tag created");
      onSaved();
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
          <DialogTitle>{isEdit ? "Edit tag" : "Create tag"}</DialogTitle>
          <DialogDescription>
            Names are slug-shaped — letters, digits, and hyphens, 1–32
            characters.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. prod, dmz, team-payments"
              maxLength={32}
              className="font-mono"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((p) => (
                <button
                  key={p.hex}
                  type="button"
                  onClick={() => setColor(p.hex)}
                  title={p.name}
                  aria-label={p.name}
                  aria-pressed={color.toLowerCase() === p.hex.toLowerCase()}
                  className={cn(
                    "h-6 w-6 rounded-sm border transition-shadow",
                    color.toLowerCase() === p.hex.toLowerCase() &&
                      "shadow-[0_0_0_2px_currentColor]"
                  )}
                  style={{ backgroundColor: p.hex, color: p.hex }}
                />
              ))}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#3b82f6"
                maxLength={9}
                className="h-8 w-32 font-mono text-xs"
              />
              <span className="text-[11px] text-muted-foreground">
                Preview:
              </span>
              <span
                className="inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] leading-none"
                style={tagChipStyle(color)}
              >
                {name.trim() || "preview"}
              </span>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="tag-description">
              Description{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="tag-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Internal note — surfaced only in this admin view."
              maxLength={200}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isEdit ? (
              <Pencil className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {isEdit ? "Save changes" : "Create tag"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete confirmation ──────────────────────────────────────────────
function TagDeleteDialog({
  state,
  onClose,
  onDeleted,
}: {
  state: DeleteState | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const open = state !== null;
  const remove = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/tags/${state.tag.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(body?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      const body = (await res.json()) as { removedAssociations: number };
      const n = body.removedAssociations;
      toast.success(
        n === 0
          ? "Tag deleted."
          : `Tag deleted. Removed from ${n} host${n === 1 ? "" : "s"}.`
      );
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
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
          <DialogTitle>Delete tag</DialogTitle>
          <DialogDescription>
            {state && state.tag.hostCount > 0
              ? `This tag is on ${state.tag.hostCount} host${
                  state.tag.hostCount === 1 ? "" : "s"
                }. Remove it from all of them?`
              : "This tag is not in use. Delete it?"}
          </DialogDescription>
        </DialogHeader>
        {state && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <TagChip tag={state.tag} />
            {state.tag.description && (
              <span className="text-xs text-muted-foreground">
                {state.tag.description}
              </span>
            )}
          </div>
        )}
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
            Delete tag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
