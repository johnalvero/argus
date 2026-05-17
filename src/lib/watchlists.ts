import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/sesClient";
import { severityRank, toSeverityBucket } from "@/lib/severity";
import type {
  NotificationChannel,
  NotificationSeverity,
  SeverityBucket,
  WatchlistKind,
  WatchlistSpec,
} from "@/lib/types";

/**
 * Watchlist evaluation engine.
 *
 * One pass:
 *   1. Read every enabled Watchlist.
 *   2. For each, resolve current matches per kind+spec.
 *   3. For each match, attempt to INSERT a Notification keyed by a
 *      stable `dedupeKey` — the (watchlistId, dedupeKey) unique index
 *      makes re-firing idempotent. New rows proceed.
 *   4. If "email" is a configured channel AND SES is enabled, fire-and-
 *      forget an email per new notification. Successes stamp
 *      `emailedAt`; failures stamp `emailError`. Email failure never
 *      blocks the in-app notification.
 *   5. Bump `lastEvaluatedAt` and `matchCount` on the watchlist.
 *
 * The caller (CVE sync finalizer, /api/v1/reports, manual trigger) is
 * expected to fire-and-forget — `evaluateWatchlists` resolves only
 * after all SES sends settle, but it never throws to the caller.
 */

const MARKER = "[watchlists]";

export type WatchlistTrigger =
  | "cve_sync_completed"
  | "host_reported"
  | "manual";

export interface EvaluateResult {
  evaluated: number;
  triggered: number;
}

interface NewNotificationDraft {
  title: string;
  body: string;
  href: string | null;
  severity: NotificationSeverity;
  dedupeKey: string;
}

interface WatchlistContext {
  id: number;
  name: string;
  kind: WatchlistKind;
  spec: WatchlistSpec;
  channels: NotificationChannel[];
  recipients: string[] | null;
  createdByEmail: string;
}

// ─── Public entry ─────────────────────────────────────────────────────
export async function evaluateWatchlists(
  trigger: WatchlistTrigger
): Promise<EvaluateResult> {
  let evaluated = 0;
  let triggered = 0;
  try {
    const watchlists = await prisma.watchlist.findMany({
      where: { enabled: true },
      include: { createdBy: { select: { email: true } } },
    });
    for (const w of watchlists) {
      evaluated++;
      let parsedSpec: WatchlistSpec;
      let parsedChannels: NotificationChannel[];
      let parsedRecipients: string[] | null;
      try {
        parsedSpec = JSON.parse(w.spec) as WatchlistSpec;
        parsedChannels = JSON.parse(w.channels) as NotificationChannel[];
        parsedRecipients = w.recipients
          ? (JSON.parse(w.recipients) as string[])
          : null;
      } catch (err) {
        console.warn(
          `${MARKER} watchlist ${w.id} (${w.name}): spec/channels parse failed:`,
          err instanceof Error ? err.message : String(err)
        );
        continue;
      }
      const ctx: WatchlistContext = {
        id: w.id,
        name: w.name,
        kind: w.kind as WatchlistKind,
        spec: parsedSpec,
        channels: parsedChannels,
        recipients: parsedRecipients,
        createdByEmail: w.createdBy?.email ?? "",
      };
      try {
        const drafts = await resolveMatches(ctx);
        const created = await persistNotifications(ctx, drafts);
        triggered += created;
        await prisma.watchlist.update({
          where: { id: ctx.id },
          data: {
            lastEvaluatedAt: new Date(),
            matchCount: { increment: created },
          },
        });
      } catch (err) {
        console.error(
          `${MARKER} watchlist ${ctx.id} (${ctx.name}) eval failed (trigger=${trigger}):`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  } catch (err) {
    console.error(
      `${MARKER} evaluateWatchlists top-level failed (trigger=${trigger}):`,
      err instanceof Error ? err.message : String(err)
    );
  }
  return { evaluated, triggered };
}

// ─── Match resolution per kind ────────────────────────────────────────
async function resolveMatches(
  ctx: WatchlistContext
): Promise<NewNotificationDraft[]> {
  switch (ctx.kind) {
    case "vulnerability":
      return resolveVulnerabilityMatches(ctx);
    case "package":
      return resolvePackageMatches(ctx);
    case "host_drift":
      return resolveHostDriftMatches(ctx);
    default:
      console.warn(`${MARKER} unknown watchlist kind: ${ctx.kind}`);
      return [];
  }
}

const SEVERITY_THRESHOLD: Record<
  "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  SeverityBucket[]
> = {
  CRITICAL: ["CRITICAL"],
  HIGH: ["CRITICAL", "HIGH"],
  MEDIUM: ["CRITICAL", "HIGH", "MEDIUM"],
  LOW: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
};

async function resolveVulnerabilityMatches(
  ctx: WatchlistContext
): Promise<NewNotificationDraft[]> {
  if (ctx.spec.kind !== "vulnerability") return [];
  const { minSeverity, ecosystem, tagIds } = ctx.spec;
  const allowed = minSeverity ? SEVERITY_THRESHOLD[minSeverity] : null;

  // Pull HostVulnerability rows joined with Vulnerability so we know
  // severity + osvId, plus the affected host id. Filters happen here
  // when expressible in Prisma; severity bucket filter happens in JS
  // because the column is free-form TEXT.
  const where: Prisma.HostVulnerabilityWhereInput = {};
  if (ecosystem && ecosystem.length > 0) {
    where.ecosystem = { in: ecosystem };
  }
  if (tagIds && tagIds.length > 0) {
    where.host = { tags: { some: { tagId: { in: tagIds } } } };
  }

  const rows = await prisma.hostVulnerability.findMany({
    where,
    select: {
      hostId: true,
      vulnerabilityId: true,
      vulnerability: {
        select: { id: true, osvId: true, severity: true, summary: true },
      },
    },
  });

  // Group by vulnerability id; collect host ids per vuln.
  const byVuln = new Map<
    number,
    {
      osvId: string;
      severity: string | null;
      summary: string;
      hostIds: Set<number>;
    }
  >();
  for (const r of rows) {
    const bucket = toSeverityBucket(r.vulnerability.severity);
    if (allowed && !allowed.includes(bucket)) continue;
    let entry = byVuln.get(r.vulnerability.id);
    if (!entry) {
      entry = {
        osvId: r.vulnerability.osvId,
        severity: r.vulnerability.severity,
        summary: r.vulnerability.summary,
        hostIds: new Set(),
      };
      byVuln.set(r.vulnerability.id, entry);
    }
    entry.hostIds.add(r.hostId);
  }

  const drafts: NewNotificationDraft[] = [];
  for (const [vulnId, entry] of byVuln) {
    const sortedHosts = [...entry.hostIds].sort((a, b) => a - b);
    const bucket = toSeverityBucket(entry.severity);
    const notifSeverity: NotificationSeverity =
      bucket === "CRITICAL"
        ? "critical"
        : bucket === "HIGH"
        ? "warning"
        : "info";
    drafts.push({
      title: `${bucket} ${entry.osvId} detected on ${sortedHosts.length} host${
        sortedHosts.length === 1 ? "" : "s"
      }`,
      body: entry.summary,
      href: `/vulnerabilities/${vulnId}`,
      severity: notifSeverity,
      dedupeKey: `vuln:${vulnId}:hosts:${sortedHosts.join(",")}`,
    });
  }
  // Highest-severity first so toasts read in the right order if many
  // fire together.
  drafts.sort((a, b) => {
    const ra = a.severity === "critical" ? 3 : a.severity === "warning" ? 2 : 1;
    const rb = b.severity === "critical" ? 3 : b.severity === "warning" ? 2 : 1;
    return rb - ra;
  });
  return drafts;
}

async function resolvePackageMatches(
  ctx: WatchlistContext
): Promise<NewNotificationDraft[]> {
  if (ctx.spec.kind !== "package") return [];
  const { name, version, ecosystem } = ctx.spec;
  if (!name) return [];

  const where: Prisma.HostPackageWhereInput = { name };
  if (version) where.version = version;
  if (ecosystem) where.ecosystem = ecosystem;

  const rows = await prisma.hostPackage.findMany({
    where,
    select: {
      hostId: true,
      ecosystem: true,
      name: true,
      version: true,
    },
  });

  // Group by (ecosystem, name, version) so a fleet running the same
  // package version produces ONE notification with N hosts in the
  // dedupe key (re-running doesn't refire while the host set is stable).
  const groups = new Map<
    string,
    { ecosystem: string; name: string; version: string; hostIds: Set<number> }
  >();
  for (const r of rows) {
    const k = `${r.ecosystem}|${r.name}|${r.version}`;
    let entry = groups.get(k);
    if (!entry) {
      entry = {
        ecosystem: r.ecosystem,
        name: r.name,
        version: r.version,
        hostIds: new Set(),
      };
      groups.set(k, entry);
    }
    entry.hostIds.add(r.hostId);
  }

  const drafts: NewNotificationDraft[] = [];
  for (const g of groups.values()) {
    const sortedHosts = [...g.hostIds].sort((a, b) => a - b);
    drafts.push({
      title: `${g.name} ${g.version} (${g.ecosystem}) found on ${sortedHosts.length} host${sortedHosts.length === 1 ? "" : "s"}`,
      body: `Package match: ${g.name} version ${g.version} in ecosystem ${g.ecosystem}.`,
      href: null,
      severity: "info",
      dedupeKey: `pkg:${g.ecosystem}:${g.name}:${g.version}:hosts:${sortedHosts.join(",")}`,
    });
  }
  return drafts;
}

async function resolveHostDriftMatches(
  ctx: WatchlistContext
): Promise<NewNotificationDraft[]> {
  if (ctx.spec.kind !== "host_drift") return [];
  const { inactiveDays, tagIds } = ctx.spec;
  if (!Number.isFinite(inactiveDays) || inactiveDays <= 0) return [];

  const threshold = new Date(Date.now() - inactiveDays * 86_400_000);
  const where: Prisma.HostWhereInput = { lastReportAt: { lt: threshold } };
  if (tagIds && tagIds.length > 0) {
    where.tags = { some: { tagId: { in: tagIds } } };
  }
  const hosts = await prisma.host.findMany({
    where,
    select: { id: true, hostname: true, lastReportAt: true },
  });

  return hosts.map((h) => ({
    title: `${h.hostname} hasn't reported in over ${inactiveDays}d`,
    body: `Host last reported ${h.lastReportAt.toISOString()}. Threshold is ${inactiveDays} day(s).`,
    href: `/hosts/${h.id}`,
    severity: "warning" as NotificationSeverity,
    dedupeKey: `drift:host:${h.id}:over:${inactiveDays}d`,
  }));
}

// ─── Persistence + email fan-out ──────────────────────────────────────
async function persistNotifications(
  ctx: WatchlistContext,
  drafts: NewNotificationDraft[]
): Promise<number> {
  if (drafts.length === 0) return 0;
  const created: { id: number; title: string; body: string; href: string | null; severity: NotificationSeverity }[] = [];
  for (const d of drafts) {
    try {
      const row = await prisma.notification.create({
        data: {
          watchlistId: ctx.id,
          title: d.title,
          body: d.body,
          href: d.href,
          severity: d.severity,
          dedupeKey: d.dedupeKey,
        },
      });
      created.push({
        id: row.id,
        title: row.title,
        body: row.body,
        href: row.href,
        severity: d.severity,
      });
    } catch (err) {
      // P2002 = UNIQUE conflict on (watchlistId, dedupeKey). Silently
      // ignore — this is the whole point of the dedupe index.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        continue;
      }
      console.warn(
        `${MARKER} watchlist ${ctx.id}: notification insert failed:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  if (created.length === 0) return 0;

  // ── Email fan-out ────────────────────────────────────────────────
  if (!ctx.channels.includes("email")) return created.length;

  // Resolve recipients. Null/empty → creator's email.
  const recipients =
    ctx.recipients && ctx.recipients.length > 0
      ? ctx.recipients
      : ctx.createdByEmail
      ? [ctx.createdByEmail]
      : [];
  if (recipients.length === 0) {
    console.warn(
      `${MARKER} watchlist ${ctx.id}: email channel set but no recipients resolved`
    );
    return created.length;
  }

  // Bail fast if SES isn't even enabled — single config read instead of
  // letting each per-notification send error out the same way.
  const sesConfig = await prisma.sesConfig.findUnique({
    where: { name: "default" },
    select: { enabled: true },
  });
  if (!sesConfig || !sesConfig.enabled) {
    return created.length;
  }

  // Send sequentially. SES has per-second send caps and we don't want
  // to fan a burst at it; sequential here also keeps SQLite writes
  // (the emailedAt stamp) ordered.
  for (const n of created) {
    try {
      const linkLine = n.href
        ? `\n\nView in Argus: ${siteUrlPrefix()}${n.href}`
        : "";
      const result = await sendEmail({
        to: recipients,
        subject: `[Argus] ${n.title}`,
        textBody: `${n.body}${linkLine}\n\nFrom watchlist: ${ctx.name}`,
        htmlBody: `<p><strong>${escapeHtml(n.title)}</strong></p><p>${escapeHtml(n.body)}</p>${
          n.href
            ? `<p><a href="${siteUrlPrefix()}${n.href}">View in Argus</a></p>`
            : ""
        }<p style="color:#64748b;font-size:12px">From watchlist: ${escapeHtml(ctx.name)}</p>`,
      });
      await prisma.notification.update({
        where: { id: n.id },
        data: { emailedAt: new Date(), emailError: null },
      });
      console.log(
        `${MARKER} watchlist ${ctx.id}: emailed notification ${n.id} (messageId=${result.messageId})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.notification
        .update({
          where: { id: n.id },
          data: { emailError: msg.slice(0, 500) },
        })
        .catch(() => {
          /* ignore secondary write failure */
        });
      console.warn(
        `${MARKER} watchlist ${ctx.id}: email failed for notification ${n.id}:`,
        msg
      );
    }
  }

  return created.length;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function siteUrlPrefix(): string {
  // PUBLIC_URL is an optional escape hatch for deployments that need
  // links in emails to be absolute. When unset we emit relative links
  // and let the recipient's mail client render them as plain text.
  return process.env.PUBLIC_URL?.replace(/\/$/, "") ?? "";
}

/**
 * Severity rank helper exported for the eval engine's tests — not used
 * directly by the runtime. Centralises the same threshold logic the
 * vulnerability matcher uses inline.
 */
export function passesMinSeverity(
  bucket: SeverityBucket,
  min: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | undefined
): boolean {
  if (!min) return true;
  return severityRank(bucket) >= severityRank(min);
}
