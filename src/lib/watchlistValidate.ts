import { prisma } from "@/lib/db";
import type {
  NotificationChannel,
  WatchlistKind,
  WatchlistSpec,
} from "@/lib/types";

/**
 * Input validation helpers for the Watchlist CRUD routes.
 *
 * The shapes mirror `WatchlistSpec` in types.ts but tolerate the wire
 * input being arbitrary `unknown` — we validate field by field and
 * return clear error strings so the UI can surface them inline.
 */

const VALID_KINDS: WatchlistKind[] = [
  "vulnerability",
  "package",
  "host_drift",
];
const VALID_CHANNELS: NotificationChannel[] = ["inapp", "email"];
const VALID_MIN_SEVERITY = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

export interface NormalizedWatchlistInput {
  name: string;
  description: string | null;
  enabled: boolean;
  kind: WatchlistKind;
  spec: WatchlistSpec;
  channels: NotificationChannel[];
  recipients: string[] | null;
}

export interface ValidationOk {
  ok: true;
  value: NormalizedWatchlistInput;
}
export interface ValidationErr {
  ok: false;
  error: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function err(msg: string): ValidationErr {
  return { ok: false, error: msg };
}

function normalizeName(raw: unknown): string | ValidationErr {
  if (typeof raw !== "string") return err("name must be a string");
  const v = raw.trim();
  if (v.length < 1 || v.length > 80) {
    return err("name must be 1–80 characters");
  }
  return v;
}

function normalizeDescription(raw: unknown): string | null | ValidationErr {
  if (raw == null) return null;
  if (typeof raw !== "string") return err("description must be a string");
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.length > 500) return err("description too long (max 500)");
  return v;
}

function normalizeChannels(raw: unknown): NotificationChannel[] | ValidationErr {
  if (!Array.isArray(raw)) return err("channels must be an array");
  const out = new Set<NotificationChannel>(["inapp"]);
  for (const c of raw) {
    if (typeof c !== "string") return err("channels: non-string entry");
    if (!(VALID_CHANNELS as readonly string[]).includes(c)) {
      return err(`channels: unknown channel "${c}"`);
    }
    out.add(c as NotificationChannel);
  }
  return [...out];
}

function normalizeRecipients(
  raw: unknown
): string[] | null | ValidationErr {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return err("recipients must be an array");
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") return err("recipients: non-string entry");
    const v = r.trim().toLowerCase();
    if (!v) continue;
    if (!EMAIL_RE.test(v)) return err(`recipients: "${r}" is not a valid email`);
    out.push(v);
  }
  return out.length === 0 ? null : out;
}

function normalizeSpec(
  kind: WatchlistKind,
  raw: unknown
): WatchlistSpec | ValidationErr {
  if (!raw || typeof raw !== "object") return err("spec must be an object");
  const s = raw as Record<string, unknown>;
  if (kind === "vulnerability") {
    const out: WatchlistSpec & { kind: "vulnerability" } = {
      kind: "vulnerability",
    };
    if (s.minSeverity != null) {
      if (
        typeof s.minSeverity !== "string" ||
        !(VALID_MIN_SEVERITY as readonly string[]).includes(s.minSeverity)
      ) {
        return err("spec.minSeverity: invalid value");
      }
      out.minSeverity = s.minSeverity as (typeof VALID_MIN_SEVERITY)[number];
    }
    if (s.ecosystem != null) {
      if (!Array.isArray(s.ecosystem)) {
        return err("spec.ecosystem: must be an array");
      }
      const eco: string[] = [];
      for (const e of s.ecosystem) {
        if (typeof e !== "string") return err("spec.ecosystem: non-string entry");
        eco.push(e);
      }
      if (eco.length > 0) out.ecosystem = eco;
    }
    if (s.tagIds != null) {
      if (!Array.isArray(s.tagIds)) return err("spec.tagIds: must be an array");
      const ids: number[] = [];
      for (const t of s.tagIds) {
        const n = Number(t);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          return err("spec.tagIds: positive integers only");
        }
        ids.push(n);
      }
      if (ids.length > 0) out.tagIds = ids;
    }
    return out;
  }
  if (kind === "package") {
    if (typeof s.name !== "string" || !s.name.trim()) {
      return err("spec.name is required");
    }
    const out: WatchlistSpec & { kind: "package" } = {
      kind: "package",
      name: s.name.trim(),
    };
    if (s.version != null) {
      if (typeof s.version !== "string") return err("spec.version must be a string");
      const v = s.version.trim();
      if (v) out.version = v;
    }
    if (s.ecosystem != null) {
      if (typeof s.ecosystem !== "string") {
        return err("spec.ecosystem must be a string");
      }
      const e = s.ecosystem.trim();
      if (e) out.ecosystem = e;
    }
    return out;
  }
  if (kind === "host_drift") {
    const n = Number(s.inactiveDays);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return err("spec.inactiveDays: positive integer required");
    }
    const out: WatchlistSpec & { kind: "host_drift" } = {
      kind: "host_drift",
      inactiveDays: n,
    };
    if (s.tagIds != null) {
      if (!Array.isArray(s.tagIds)) return err("spec.tagIds: must be an array");
      const ids: number[] = [];
      for (const t of s.tagIds) {
        const id = Number(t);
        if (!Number.isFinite(id) || !Number.isInteger(id) || id < 1) {
          return err("spec.tagIds: positive integers only");
        }
        ids.push(id);
      }
      if (ids.length > 0) out.tagIds = ids;
    }
    return out;
  }
  return err(`unknown kind: ${kind}`);
}

/**
 * Resolve the recipient-domain allowlist.
 *
 * Precedence:
 *   1. `SES_RECIPIENT_ALLOWED_DOMAINS` env (comma-separated) — explicit
 *      operator override, useful when you want to email partners outside
 *      your own domain.
 *   2. The domain part of `SesConfig.fromAddress`.
 *   3. null — no SES configured yet; we let any well-formed email
 *      through so an admin can pre-stage watchlists before SES is set
 *      up. The watchlist evaluator will still fail at send time, but
 *      that's no worse than today.
 *
 * Returns the lowercase domain set, or null when no allowlist applies.
 */
async function loadRecipientDomainAllowlist(): Promise<Set<string> | null> {
  const env = process.env.SES_RECIPIENT_ALLOWED_DOMAINS;
  if (env && env.trim()) {
    const set = new Set(
      env
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0)
    );
    if (set.size > 0) return set;
  }
  try {
    const ses = await prisma.sesConfig.findUnique({
      where: { name: "default" },
      select: { fromAddress: true },
    });
    const from = ses?.fromAddress;
    if (!from) return null;
    const at = from.lastIndexOf("@");
    if (at < 0) return null;
    const domain = from.slice(at + 1).trim().toLowerCase();
    return domain ? new Set([domain]) : null;
  } catch {
    return null;
  }
}

function checkRecipientDomains(
  recipients: string[],
  allow: Set<string>
): ValidationErr | null {
  for (const r of recipients) {
    const at = r.lastIndexOf("@");
    if (at < 0) return err(`recipients: "${r}" missing domain`);
    const domain = r.slice(at + 1).toLowerCase();
    if (!allow.has(domain)) {
      return err(
        `recipients: "${r}" — domain not in allowlist (${[...allow].join(", ")}). ` +
          `Override via SES_RECIPIENT_ALLOWED_DOMAINS env if needed.`
      );
    }
  }
  return null;
}

export async function validateWatchlistInput(
  body: unknown
): Promise<ValidationResult> {
  if (!body || typeof body !== "object") {
    return err("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const name = normalizeName(b.name);
  if (typeof name !== "string") return name;

  const description = normalizeDescription(b.description);
  if (description != null && typeof description !== "string") {
    return description;
  }

  const enabled =
    b.enabled === undefined ? true : Boolean(b.enabled);

  if (typeof b.kind !== "string" || !(VALID_KINDS as readonly string[]).includes(b.kind)) {
    return err("kind: must be one of vulnerability, package, host_drift");
  }
  const kind = b.kind as WatchlistKind;

  const spec = normalizeSpec(kind, b.spec);
  if ("ok" in spec && spec.ok === false) return spec;

  const channels = normalizeChannels(b.channels ?? ["inapp"]);
  if ("ok" in channels && channels.ok === false) return channels;

  const recipients = normalizeRecipients(b.recipients);
  if (recipients != null && !Array.isArray(recipients)) return recipients;

  // M5: recipient domain allowlist. Only enforced when SES has a from
  // address (or the operator set an explicit env override) — otherwise
  // we'd block legitimate pre-SES setup.
  if (Array.isArray(recipients) && recipients.length > 0) {
    const allow = await loadRecipientDomainAllowlist();
    if (allow) {
      const domainErr = checkRecipientDomains(recipients, allow);
      if (domainErr) return domainErr;
    }
  }

  return {
    ok: true,
    value: {
      name,
      description,
      enabled,
      kind,
      spec: spec as WatchlistSpec,
      channels: channels as NotificationChannel[],
      recipients: (recipients ?? null) as string[] | null,
    },
  };
}

/**
 * PATCH input validator — every field optional. Returns a partial that
 * the route maps onto Prisma update data after re-serialising spec /
 * channels / recipients.
 */
export interface PartialWatchlistInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  kind?: WatchlistKind;
  spec?: WatchlistSpec;
  channels?: NotificationChannel[];
  recipients?: string[] | null;
}

export async function validateWatchlistPatch(
  body: unknown,
  currentKind: WatchlistKind
): Promise<{ ok: true; value: PartialWatchlistInput } | ValidationErr> {
  if (!body || typeof body !== "object") {
    return err("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const out: PartialWatchlistInput = {};

  if ("name" in b) {
    const n = normalizeName(b.name);
    if (typeof n !== "string") return n;
    out.name = n;
  }
  if ("description" in b) {
    const d = normalizeDescription(b.description);
    if (d != null && typeof d !== "string") return d;
    out.description = d as string | null;
  }
  if ("enabled" in b) {
    out.enabled = Boolean(b.enabled);
  }
  let kindForSpec: WatchlistKind = currentKind;
  if ("kind" in b) {
    if (typeof b.kind !== "string" || !(VALID_KINDS as readonly string[]).includes(b.kind)) {
      return err("kind: must be one of vulnerability, package, host_drift");
    }
    out.kind = b.kind as WatchlistKind;
    kindForSpec = out.kind;
  }
  if ("spec" in b) {
    const s = normalizeSpec(kindForSpec, b.spec);
    if ("ok" in s && s.ok === false) return s;
    out.spec = s as WatchlistSpec;
  }
  if ("channels" in b) {
    const c = normalizeChannels(b.channels);
    if ("ok" in c && c.ok === false) return c;
    out.channels = c as NotificationChannel[];
  }
  if ("recipients" in b) {
    const r = normalizeRecipients(b.recipients);
    if (r != null && !Array.isArray(r)) return r;
    out.recipients = (r ?? null) as string[] | null;
    if (Array.isArray(r) && r.length > 0) {
      const allow = await loadRecipientDomainAllowlist();
      if (allow) {
        const domainErr = checkRecipientDomains(r, allow);
        if (domainErr) return domainErr;
      }
    }
  }
  if (Object.keys(out).length === 0) {
    return err("no recognised fields to update");
  }
  return { ok: true, value: out };
}
