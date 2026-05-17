"use client";

import { useState } from "react";
import useSWR from "swr";
import { Copy, KeyRound, Loader2, Plus, Power, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/fetcher";
import { timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { IngestTokenRow } from "@/lib/types";

interface CreatedToken {
  id: number;
  name: string;
  prefix: string;
  token: string;
}

export default function TokensPage() {
  const { data, mutate, isLoading, error } = useSWR<IngestTokenRow[]>(
    "/api/admin/tokens",
    jsonFetcher
  );

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(body?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      const body = (await res.json()) as CreatedToken;
      setCreated(body);
      setNewName("");
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "create failed");
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (token: IngestTokenRow) => {
    const res = await fetch(`/api/admin/tokens/${token.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !token.enabled }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      toast.error(body?.error ?? "toggle failed");
      return;
    }
    toast.success(token.enabled ? "Token disabled" : "Token enabled");
    mutate();
  };

  const remove = async (token: IngestTokenRow) => {
    if (!confirm(`Delete token "${token.name}"? Agents using it will stop ingesting.`)) {
      return;
    }
    const res = await fetch(`/api/admin/tokens/${token.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      toast.error(body?.error ?? "delete failed");
      return;
    }
    toast.success("Token deleted");
    mutate();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight">Ingest tokens</h3>
        <p className="text-xs text-muted-foreground">
          Bearer tokens used by <span className="font-mono">software-inventory.sh</span> agents.
          The raw value is shown exactly once on creation.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Create a new token</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 md:flex-row md:items-end">
            <div className="flex-1 grid gap-1.5">
              <Label htmlFor="newName">Label</Label>
              <Input
                id="newName"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. fleet-prod"
              />
            </div>
            <Button onClick={create} disabled={creating || !newName.trim()}>
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create token
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Tokens{" "}
            <span className="text-muted-foreground font-normal">
              ({data?.length ?? 0})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error instanceof Error ? error.message : "failed to load"}
            </div>
          )}
          {!error && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-xs text-muted-foreground"
                    >
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && (data?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-xs text-muted-foreground"
                    >
                      No tokens yet.
                    </TableCell>
                  </TableRow>
                )}
                {data?.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <KeyRound className="h-3 w-3 text-muted-foreground" />
                        {t.name}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {t.prefix}…
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.createdByEmail}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.lastUsedAt ? timeAgo(t.lastUsedAt) : "never"}
                    </TableCell>
                    <TableCell>
                      {t.enabled ? (
                        <Badge variant="success">enabled</Badge>
                      ) : (
                        <Badge variant="muted">disabled</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggle(t)}
                          title={t.enabled ? "Disable" : "Enable"}
                        >
                          <Power className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => remove(t)}
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
          )}
        </CardContent>
      </Card>

      <CreatedTokenDialog
        created={created}
        onClose={() => setCreated(null)}
      />
    </div>
  );
}

function CreatedTokenDialog({
  created,
  onClose,
}: {
  created: CreatedToken | null;
  onClose: () => void;
}) {
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Clipboard write failed");
    }
  };
  return (
    <Dialog
      open={created !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Token created</DialogTitle>
          <DialogDescription>
            This is the only time you will see the raw token. Copy it now and
            store it somewhere safe — the server only keeps a bcrypt hash.
          </DialogDescription>
        </DialogHeader>
        {created && (
          <div className="flex flex-col gap-2">
            <Label>Label</Label>
            <p className="text-sm">{created.name}</p>
            <Label>Token</Label>
            <pre className="overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
              {created.token}
            </pre>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={copy}>
            <Copy className="h-3 w-3" /> Copy
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
