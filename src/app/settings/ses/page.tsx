"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Check, Loader2, Mail, Send, X } from "lucide-react";
import { toast } from "sonner";
import { jsonFetcher } from "@/lib/fetcher";
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
import { timeAgo } from "@/lib/utils";
import type { SesConfigPublic } from "@/lib/types";

/**
 * Admin → Email (SES).
 *
 * Single Card with the config fields. The secret access key field
 * shows masked dots when `hasSecret` is true; pasting a new value
 * replaces the encrypted-at-rest secret on save.
 */

const SECRET_PLACEHOLDER = "••••••••••••••••";

interface FormState {
  enabled: boolean;
  region: string;
  accessKeyId: string;
  /** Empty unless the admin is changing it. */
  secretAccessKey: string;
  fromAddress: string;
  replyTo: string;
}

const EMPTY_FORM: FormState = {
  enabled: false,
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
  fromAddress: "",
  replyTo: "",
};

export default function SesSettingsPage() {
  const { data, mutate, isLoading, error } = useSWR<SesConfigPublic>(
    "/api/admin/ses",
    jsonFetcher
  );

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Hydrate the form from the server response. The secret field stays
  // empty — `hasSecret` drives the placeholder render.
  useEffect(() => {
    if (!data) return;
    setForm({
      enabled: data.enabled,
      region: data.region ?? "",
      accessKeyId: data.accessKeyId ?? "",
      secretAccessKey: "",
      fromAddress: data.fromAddress ?? "",
      replyTo: data.replyTo ?? "",
    });
  }, [data]);

  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      // Only include secretAccessKey if the admin actually typed
      // something — empty means "keep existing".
      const body: Record<string, unknown> = {
        enabled: form.enabled,
        region: form.region.trim() || null,
        accessKeyId: form.accessKeyId.trim() || null,
        fromAddress: form.fromAddress.trim() || null,
        replyTo: form.replyTo.trim() || null,
      };
      if (form.secretAccessKey.trim()) {
        body.secretAccessKey = form.secretAccessKey;
      }
      const res = await fetch("/api/admin/ses", {
        method: "PUT",
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
      toast.success("SES config saved");
      // Clear the secret field after a successful save so the masked
      // placeholder takes over again.
      setForm((f) => ({ ...f, secretAccessKey: "" }));
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (!testTo.trim()) {
      toast.error("Enter a recipient address");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch("/api/admin/ses/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const b = (await res.json().catch(() => null)) as
        | { ok?: boolean; messageId?: string; error?: string }
        | null;
      if (!res.ok || !b?.ok) {
        toast.error(b?.error ?? `${res.status} ${res.statusText}`);
      } else {
        toast.success(`Test email sent (messageId: ${b.messageId ?? "—"})`);
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "test failed");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight">Email (SES)</h3>
        <p className="text-xs text-muted-foreground">
          Transport for watchlist email notifications. Uses AWS SES v2.
          The secret access key is encrypted at rest with a JWT_SECRET-
          derived AES-256-GCM key.
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
            <Mail className="h-4 w-4 text-muted-foreground" />
            Configuration
          </CardTitle>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) =>
                setForm((f) => ({ ...f, enabled: e.target.checked }))
              }
              className="h-4 w-4"
            />
            <span>Enabled</span>
          </label>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ses-region">Region</Label>
              <Input
                id="ses-region"
                value={form.region}
                onChange={(e) =>
                  setForm((f) => ({ ...f, region: e.target.value }))
                }
                placeholder="ap-southeast-1"
                className="font-mono text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ses-from">From address</Label>
              <Input
                id="ses-from"
                value={form.fromAddress}
                onChange={(e) =>
                  setForm((f) => ({ ...f, fromAddress: e.target.value }))
                }
                placeholder="argus@example.com"
                className="font-mono text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ses-key">Access key ID</Label>
              <Input
                id="ses-key"
                value={form.accessKeyId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, accessKeyId: e.target.value }))
                }
                placeholder="AKIA..."
                className="font-mono text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ses-secret" className="flex items-center gap-2">
                Secret access key
                {data?.hasSecret && (
                  <Badge variant="success" className="text-[10px]">
                    secret set
                  </Badge>
                )}
              </Label>
              <Input
                id="ses-secret"
                type="password"
                value={form.secretAccessKey}
                onChange={(e) =>
                  setForm((f) => ({ ...f, secretAccessKey: e.target.value }))
                }
                placeholder={data?.hasSecret ? SECRET_PLACEHOLDER : "—"}
                className="font-mono text-xs"
                autoComplete="new-password"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ses-reply">Reply-to (optional)</Label>
              <Input
                id="ses-reply"
                value={form.replyTo}
                onChange={(e) =>
                  setForm((f) => ({ ...f, replyTo: e.target.value }))
                }
                placeholder="noreply@example.com"
                className="font-mono text-xs"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={save} disabled={saving || isLoading}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save changes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Send className="h-4 w-4 text-muted-foreground" />
            Send test email
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 grid gap-1.5">
              <Label htmlFor="ses-test-to">Recipient</Label>
              <Input
                id="ses-test-to"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@example.com"
                className="font-mono text-xs"
              />
            </div>
            <Button
              onClick={sendTest}
              disabled={testing || !form.enabled}
              variant="outline"
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send test
            </Button>
          </div>
          {data?.lastTestAt && (
            <div className="mt-3 flex items-center gap-2 text-xs">
              {data.lastTestOk ? (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <X className="h-3.5 w-3.5 text-destructive" />
              )}
              <span className="text-muted-foreground">
                Last test {timeAgo(data.lastTestAt)} —{" "}
                {data.lastTestOk ? "succeeded" : "failed"}
              </span>
              {data.lastTestError && (
                <span className="font-mono text-[11px] text-destructive">
                  {data.lastTestError}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
