"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * Install agent page.
 *
 * Admin-only. Renders three copy-paste snippets (SSH, cloud-init, manual)
 * that wire a target host up to this collector. The page itself never
 * sees the raw token from the server side — the operator pastes it,
 * and we optionally round-trip it through the verify endpoint to
 * confirm it matches a stored hash.
 */

interface ScheduleOption {
  label: string;
  value: string;
}

const SCHEDULES: ScheduleOption[] = [
  { label: "Daily at 3 AM", value: "0 3 * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Hourly", value: "0 * * * *" },
];

// Minimal 5-field cron sanity check. Not exhaustive — we accept the
// usual *, */N, N, N-M, N,M syntactic forms per field. Wrong values
// (e.g. minute=99) will be caught downstream by cron/systemd.
const CRON_FIELD = /^(\*|\*\/\d+|\d+(-\d+)?(\/\d+)?(,\d+(-\d+)?(\/\d+)?)*)$/;
function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => CRON_FIELD.test(p));
}

const PLACEHOLDER_TOKEN = "<your-token>";

type VerifyState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; name: string }
  | { kind: "bad" }
  | { kind: "error"; message: string };

export default function InstallPage() {
  const [token, setToken] = useState("");
  const [scheduleChoice, setScheduleChoice] = useState<string>("0 3 * * *");
  const [customCron, setCustomCron] = useState("");
  const [origin, setOrigin] = useState<string>("");
  const [verify, setVerify] = useState<VerifyState>({ kind: "idle" });

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // Reset verify whenever the token text changes — stale green checks
  // are worse than no check.
  useEffect(() => {
    setVerify({ kind: "idle" });
  }, [token]);

  const usingCustom = scheduleChoice === "custom";
  const schedule = usingCustom ? customCron.trim() : scheduleChoice;
  const scheduleValid = usingCustom ? isValidCron(customCron.trim()) : true;

  const tokenForSnippet = token.trim() || PLACEHOLDER_TOKEN;
  const collectorReportsUrl = origin ? `${origin}/api/v1/reports` : "";
  const bootstrapUrl = origin ? `${origin}/install/bootstrap.sh` : "";
  const agentUrl = origin ? `${origin}/install/agent.sh` : "";

  const sshSnippet = useMemo(
    () =>
      `ssh user@host "curl -sSfL ${bootstrapUrl} | sudo bash -s -- --token ${tokenForSnippet} --collector-url ${collectorReportsUrl} --schedule '${schedule}'"`,
    [bootstrapUrl, tokenForSnippet, collectorReportsUrl, schedule]
  );

  const cloudInitSnippet = useMemo(
    () =>
      `#cloud-config
runcmd:
  - curl -sSfL ${bootstrapUrl} | bash -s -- --token ${tokenForSnippet} --collector-url ${collectorReportsUrl} --schedule '${schedule}'`,
    [bootstrapUrl, tokenForSnippet, collectorReportsUrl, schedule]
  );

  const manualSteps = useMemo(
    () => ({
      download: `curl -sSfL ${agentUrl} -o /usr/local/sbin/software-inventory.sh && chmod +x /usr/local/sbin/software-inventory.sh`,
      env: `sudo install -d -m 750 /etc/inventory-agent && printf 'COLLECTOR_URL=%s\\nCOLLECTOR_TOKEN=%s\\n' '${collectorReportsUrl}' '${tokenForSnippet}' | sudo tee /etc/inventory-agent/env >/dev/null && sudo chmod 600 /etc/inventory-agent/env`,
      cron: `echo '${schedule} root . /etc/inventory-agent/env && /usr/local/sbin/software-inventory.sh' | sudo tee /etc/cron.d/inventory-agent`,
      systemd: `cat <<'EOF' | sudo tee /etc/systemd/system/inventory-agent.service >/dev/null
[Unit]
Description=Software inventory reporter
After=network-online.target
[Service]
Type=oneshot
EnvironmentFile=/etc/inventory-agent/env
ExecStart=/usr/local/sbin/software-inventory.sh
EOF
cat <<'EOF' | sudo tee /etc/systemd/system/inventory-agent.timer >/dev/null
[Unit]
Description=Run inventory agent on schedule
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now inventory-agent.timer`,
      run: `sudo bash -c '. /etc/inventory-agent/env && /usr/local/sbin/software-inventory.sh'`,
    }),
    [agentUrl, collectorReportsUrl, tokenForSnippet, schedule]
  );

  const runVerify = async () => {
    const raw = token.trim();
    if (!raw) return;
    setVerify({ kind: "checking" });
    try {
      const res = await fetch("/api/admin/verify-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: raw }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setVerify({
          kind: "error",
          message: body?.error ?? `${res.status} ${res.statusText}`,
        });
        return;
      }
      const body = (await res.json()) as {
        valid: boolean;
        tokenName?: string;
      };
      setVerify(
        body.valid && body.tokenName
          ? { kind: "ok", name: body.tokenName }
          : { kind: "bad" }
      );
    } catch (err) {
      setVerify({
        kind: "error",
        message: err instanceof Error ? err.message : "verify failed",
      });
    }
  };

  const tokenMissing = !token.trim();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight">
          Install agent on a host
        </h3>
        <p className="text-xs text-muted-foreground">
          Copy a snippet, paste on the target host, done. Choose a method below.
        </p>
      </div>

      {/* Top form — sticky so the snippets always have context. */}
      <Card className="sticky top-2 z-10">
        <CardHeader>
          <CardTitle className="text-sm">Configure</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Token */}
          <div className="grid gap-1.5">
            <Label htmlFor="token">Ingest token</Label>
            <div className="flex items-center gap-2">
              <Input
                id="token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="argus_…"
                className="font-mono text-xs"
                spellCheck={false}
                autoComplete="off"
              />
              <Button
                variant="outline"
                onClick={runVerify}
                disabled={tokenMissing || verify.kind === "checking"}
              >
                {verify.kind === "checking" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : verify.kind === "ok" ? (
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                ) : verify.kind === "bad" || verify.kind === "error" ? (
                  <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Verify
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste a token you&apos;ve created in{" "}
              <span className="font-mono">Ingest tokens</span>. The collector
              only stores a hash — we can&apos;t recover the raw value for you.
            </p>
            <VerifyMessage state={verify} />
          </div>

          {/* Schedule */}
          <div className="grid gap-2">
            <Label>Schedule</Label>
            <div className="flex flex-wrap items-center gap-2">
              {SCHEDULES.map((s) => (
                <RadioPill
                  key={s.value}
                  label={s.label}
                  value={s.value}
                  current={scheduleChoice}
                  onSelect={setScheduleChoice}
                />
              ))}
              <RadioPill
                label="Custom…"
                value="custom"
                current={scheduleChoice}
                onSelect={setScheduleChoice}
              />
            </div>
            {usingCustom && (
              <div className="flex flex-col gap-1">
                <Input
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="*/15 * * * *"
                  className="font-mono text-xs"
                  spellCheck={false}
                />
                {customCron.trim() && !scheduleValid && (
                  <span className="text-xs text-destructive">
                    Not a valid 5-field cron expression.
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Collector URL — read-only mirror of window.location.origin */}
          <div className="grid gap-1.5">
            <Label>Collector URL</Label>
            <code className="block truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs text-muted-foreground">
              {collectorReportsUrl || "—"}
            </code>
          </div>
        </CardContent>
      </Card>

      {tokenMissing && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            No token pasted yet — snippets show the literal placeholder{" "}
            <span className="font-mono">{PLACEHOLDER_TOKEN}</span>. Replace it
            before running, or paste a real token above and the snippets will
            update live.
          </span>
        </div>
      )}

      {/* Snippet tabs */}
      <Tabs defaultValue="ssh" className="w-full">
        <TabsList>
          <TabsTrigger value="ssh">SSH</TabsTrigger>
          <TabsTrigger value="cloud-init">Cloud-init</TabsTrigger>
          <TabsTrigger value="manual">Manual</TabsTrigger>
        </TabsList>

        <TabsContent value="ssh">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">SSH one-liner</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <CodeBlock content={sshSnippet} />
              <p className="text-xs text-muted-foreground">
                Replace <span className="font-mono">user@host</span> with the
                actual SSH target. The script will install the agent, set up a
                systemd timer (or cron), and run one immediate ingest to verify.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cloud-init">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Cloud-init user-data</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <CodeBlock content={cloudInitSnippet} />
              <p className="text-xs text-muted-foreground">
                Paste into the user-data / startup-script field at instance
                launch. Cloud-init runs as root automatically.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="manual">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Manual install</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ol className="flex flex-col gap-3 text-xs">
                <ManualStep
                  n={1}
                  title="Download the agent"
                  code={manualSteps.download}
                />
                <ManualStep
                  n={2}
                  title="Write the env file"
                  code={manualSteps.env}
                />
                <ManualStep
                  n={3}
                  title="Schedule (cron)"
                  code={manualSteps.cron}
                  extra={
                    <details className="mt-2">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        Use a systemd timer instead
                      </summary>
                      <div className="mt-2">
                        <CodeBlock content={manualSteps.systemd} />
                      </div>
                    </details>
                  }
                />
                <ManualStep
                  n={4}
                  title="First run"
                  code={manualSteps.run}
                />
              </ol>
              <p className="text-xs text-muted-foreground">
                Use these when curl can&apos;t reach the collector during
                install, or when you want to vet each step.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Small components ─────────────────────────────────────────────────────

function VerifyMessage({ state }: { state: VerifyState }) {
  if (state.kind === "ok") {
    return (
      <p className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <Check className="h-3 w-3" /> Matches token{" "}
        <span className="font-mono">{state.name}</span>
      </p>
    );
  }
  if (state.kind === "bad") {
    return (
      <p className="inline-flex items-center gap-1 text-xs text-destructive">
        <X className="h-3 w-3" /> No enabled token matches this value.
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="inline-flex items-center gap-1 text-xs text-destructive">
        <X className="h-3 w-3" /> Verify failed: {state.message}
      </p>
    );
  }
  return null;
}

function RadioPill({
  label,
  value,
  current,
  onSelect,
}: {
  label: string;
  value: string;
  current: string;
  onSelect: (v: string) => void;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center rounded-md border px-2.5 text-xs transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}

function CodeBlock({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      toast.success("Copied!");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Clipboard write failed");
    }
  };
  return (
    <div className="relative">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-3 pr-12 font-mono text-xs leading-relaxed">
        {content}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={copy}
        aria-label="Copy snippet"
        className="absolute right-1.5 top-1.5 h-7 px-2"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

function ManualStep({
  n,
  title,
  code,
  extra,
}: {
  n: number;
  title: string;
  code: string;
  extra?: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border bg-background text-[10px] font-medium">
          {n}
        </span>
        <span className="font-medium text-foreground">{title}</span>
      </div>
      <CodeBlock content={code} />
      {extra}
    </li>
  );
}
