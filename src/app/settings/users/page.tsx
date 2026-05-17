"use client";

import { useState } from "react";
import useSWR from "swr";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMe } from "@/lib/useMe";
import type { UserRow } from "@/lib/types";

export default function UsersPage() {
  const { data, mutate, isLoading, error } = useSWR<UserRow[]>(
    "/api/admin/users",
    jsonFetcher
  );
  const { data: me } = useMe();

  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);

  const create = async () => {
    if (!newEmail.trim() || newPassword.length < 8) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newEmail.trim(),
          password: newPassword,
          isAdmin: newIsAdmin,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(body?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      toast.success("User created. They must change password on first login.");
      setNewEmail("");
      setNewPassword("");
      setNewIsAdmin(false);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "create failed");
    } finally {
      setCreating(false);
    }
  };

  const remove = async (u: UserRow) => {
    if (!confirm(`Delete user "${u.email}"?`)) return;
    const res = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      toast.error(body?.error ?? "delete failed");
      return;
    }
    toast.success("User deleted");
    mutate();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">UI users</h2>
        <p className="text-sm text-muted-foreground">
          Local accounts only (no SSO in v1). New users must change their
          password on first sign-in.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Create a new user</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-4 md:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="newEmail">Email</Label>
              <Input
                id="newEmail"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="newPassword">Initial password (≥ 8 chars)</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={newIsAdmin}
                onChange={(e) => setNewIsAdmin(e.target.checked)}
              />
              Admin
            </label>
            <Button
              onClick={create}
              disabled={
                creating || !newEmail.trim() || newPassword.length < 8
              }
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Users{" "}
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
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center text-xs text-muted-foreground"
                    >
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {data?.map((u) => {
                  const isSelf = me?.id === u.id;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="text-xs">{u.email}</TableCell>
                      <TableCell>
                        {u.isAdmin ? (
                          <Badge variant="info">admin</Badge>
                        ) : (
                          <Badge variant="muted">user</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {u.mustChangePassword ? (
                          <Badge variant="warning">must change pwd</Badge>
                        ) : (
                          <Badge variant="success">active</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {timeAgo(u.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setResetTarget(u)}
                            disabled={isSelf}
                            title="Reset password"
                          >
                            <KeyRound className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => remove(u)}
                            disabled={isSelf}
                            title="Delete"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ResetPasswordDialog
        target={resetTarget}
        onClose={() => setResetTarget(null)}
        onSuccess={() => {
          mutate();
          setResetTarget(null);
        }}
      />
    </div>
  );
}

function ResetPasswordDialog({
  target,
  onClose,
  onSuccess,
}: {
  target: UserRow | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!target || password.length < 8) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/users/${target.id}/reset-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(body?.error ?? "reset failed");
        return;
      }
      toast.success("Password reset. The user must change it on next sign-in.");
      setPassword("");
      onSuccess();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPassword("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
        </DialogHeader>
        {target && (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              For <span className="font-mono">{target.email}</span>:
            </p>
            <Label htmlFor="resetPwd">New password (≥ 8 chars)</Label>
            <Input
              id="resetPwd"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || password.length < 8}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
