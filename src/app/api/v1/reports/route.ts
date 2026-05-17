import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCollectorConfig } from "@/lib/collectorConfig";
import { runCleanup, shouldRunCleanup } from "@/lib/cleanup";
import { extractBearer, verifyIngestToken } from "@/lib/ingestToken";
import { parseReportPayload } from "@/lib/reportPayload";
import { evaluateWatchlists } from "@/lib/watchlists";
import { checkContentLength } from "@/lib/requestGuards";
import { checkIngestRateLimit } from "@/lib/ingestRateLimit";

/**
 * POST /api/v1/reports — agent ingest endpoint.
 *
 * Auth: bearer token (NOT JWT). `Authorization: Bearer argus_<…>` (or
 * legacy `sbom_…` from before the rename — both prefixes verified).
 * Lookup hits the prefix-indexed IngestToken table, then bcrypt-compares.
 *
 * Pipeline:
 *   1. Auth + size cap (5 MB raw body).
 *   2. Parse JSON + validate required fields.
 *   3. sha256 the raw body; if it matches Host.lastReportHash → 202.
 *   4. Upsert Host, insert Report, wipe + re-insert HostPackage rows
 *      (OS + language packages, discriminated by `ecosystem`), update
 *      token.lastUsedAt.
 *   5. Fire-and-forget data retention sweep (throttled to once / 24h
 *      via cfg.lastCleanupAt). Never blocks the ingest response.
 *   6. Return { ok, reportId }.
 *
 * The whole write is wrapped in a transaction so the package index
 * stays in lockstep with the report row.
 */

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  // ── 1. Pre-flight body size cap from Content-Length. ──────────────
  // Rejects a hostile 500 MB upload before we ever call req.text().
  // The post-parse check below still defends against missing/lying
  // Content-Length (chunked transfer).
  const preSize = checkContentLength(req, { max: MAX_BODY_BYTES });
  if (preSize) return preSize;

  // ── 2. Auth ────────────────────────────────────────────────────────
  const auth = extractBearer(req.headers.get("authorization"));
  if (!auth) {
    return NextResponse.json(
      { error: "missing bearer token" },
      { status: 401 }
    );
  }
  const verified = await verifyIngestToken(auth);
  if (!verified) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  // ── 2b. Per-token rate limit. ─────────────────────────────────────
  // 60 rpm leaky bucket per ingest-token id — generous enough that the
  // normal daily-ping cadence is fine, tight enough that a misconfigured
  // agent in a loop can't pin the DB.
  const rl = checkIngestRateLimit(verified.token.id);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))
          ),
        },
      }
    );
  }

  // ── 3. Body read + post-parse size cap. ───────────────────────────
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "could not read body" }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload too large (max 5 MB)" },
      { status: 413 }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "malformed JSON" }, { status: 400 });
  }

  const result = parseReportPayload(parsed);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const payload = result.data;

  // ── 3. Hash + dedupe ──────────────────────────────────────────────
  const hash = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

  const existingHost = await prisma.host.findUnique({
    where: { hostId: payload.host_id },
    select: { id: true, lastReportHash: true },
  });
  if (existingHost && existingHost.lastReportHash === hash) {
    // Still bump token.lastUsedAt — a healthy unchanged-report ping is
    // useful liveness signal.
    await prisma.ingestToken.update({
      where: { id: verified.token.id },
      data: { lastUsedAt: new Date() },
    });
    return NextResponse.json(
      { ok: true, status: "unchanged", hostId: existingHost.id },
      { status: 202 }
    );
  }

  // ── 4. Write ──────────────────────────────────────────────────────
  const collectedAt = payload.collected_at
    ? new Date(payload.collected_at)
    : new Date();
  const validCollectedAt = !Number.isNaN(collectedAt.getTime())
    ? collectedAt
    : new Date();

  // Resolve IP fields. `privateIp` is the first reported address (or
  // null when the agent saw no global-scope IPv4 — happens on hosts
  // that haven't come up yet). `ipAddresses` is the full JSON array.
  const ipList = payload.ip_addresses ?? [];
  const primaryIp =
    ipList.length > 0 && typeof ipList[0]?.addr === "string"
      ? ipList[0].addr
      : null;
  const ipAddressesJson = ipList.length > 0 ? JSON.stringify(ipList) : null;

  const reportId = await prisma.$transaction(async (tx) => {
    // Upsert host. Note: firstSeenAt is set only on create; subsequent
    // upserts keep the original.
    const host = await tx.host.upsert({
      where: { hostId: payload.host_id },
      create: {
        hostId: payload.host_id,
        hostname: payload.hostname,
        osId: payload.os.id,
        osName: payload.os.name,
        osVersion: payload.os.version,
        osVersionCodename: payload.os.version_codename ?? null,
        kernel: payload.kernel ?? null,
        arch: payload.arch ?? null,
        packageManager: payload.package_manager ?? null,
        agentVersion: payload.agent_version ?? null,
        privateIp: primaryIp,
        ipAddresses: ipAddressesJson,
        lastReportAt: validCollectedAt,
        lastReportHash: hash,
      },
      update: {
        hostname: payload.hostname,
        osId: payload.os.id,
        osName: payload.os.name,
        osVersion: payload.os.version,
        osVersionCodename: payload.os.version_codename ?? null,
        kernel: payload.kernel ?? null,
        arch: payload.arch ?? null,
        packageManager: payload.package_manager ?? null,
        agentVersion: payload.agent_version ?? null,
        privateIp: primaryIp,
        ipAddresses: ipAddressesJson,
        lastReportAt: validCollectedAt,
        lastReportHash: hash,
      },
    });

    const report = await tx.report.create({
      data: {
        hostId: host.id,
        payload: raw,
        hash,
        collectedAt: validCollectedAt,
      },
    });

    // Replace the package index for this host. SQLite handles a few
    // hundred-row delete + createMany in a single transaction trivially.
    await tx.hostPackage.deleteMany({ where: { hostId: host.id } });

    // OS packages — ecosystem="os", arch from the payload. Dedupe on
    // the unique key — some package managers emit multi-arch dups.
    const seen = new Set<string>();
    const osRows = payload.packages
      .filter((p) => {
        const key = `os|${p.name}|${p.version}|${p.arch}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((p) => ({
        hostId: host.id,
        ecosystem: "os",
        location: null,
        name: p.name,
        version: p.version,
        arch: p.arch,
      }));

    // Language packages (pip, npm, gem, composer, cargo, snap, flatpak,
    // …). Arch is empty for the classic language ecosystems and only
    // meaningful for snap ("all") / flatpak ("x86_64"). The unique key
    // includes arch so a per-arch flatpak doesn't collide with itself.
    const langRows = (payload.language_packages ?? [])
      .filter((p) => {
        const arch = p.arch ?? "";
        const key = `${p.ecosystem}|${p.name}|${p.version}|${arch}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((p) => ({
        hostId: host.id,
        ecosystem: p.ecosystem,
        location: p.location ?? null,
        name: p.name,
        version: p.version,
        arch: p.arch ?? "",
      }));

    const allRows = [...osRows, ...langRows];
    if (allRows.length > 0) {
      await tx.hostPackage.createMany({ data: allRows });
    }

    return report.id;
  });

  // ── 5. Token bookkeeping (outside the txn — cheap & non-critical) ─
  await prisma.ingestToken.update({
    where: { id: verified.token.id },
    data: { lastUsedAt: new Date() },
  });

  // ── 6. Auto-cleanup (fire-and-forget, throttled). ─────────────────
  // Re-uses the same getCollectorConfig() as the public config endpoint.
  // We check the throttle BEFORE handing off so we don't spawn a stray
  // async chain on every ingest — only when there's real work to do.
  // A slow cleanup MUST NOT delay the agent's response.
  try {
    const cfg = await getCollectorConfig();
    if (shouldRunCleanup(cfg)) {
      runCleanup(cfg).catch((err) => {
        console.error(
          "cleanup failed",
          err instanceof Error ? err.message : String(err)
        );
      });
    }
  } catch (err) {
    // Failure to even read the config shouldn't poison the ingest.
    console.error(
      "cleanup scheduling failed",
      err instanceof Error ? err.message : String(err)
    );
  }

  // Fire-and-forget watchlist evaluation — primarily for host_drift +
  // package matches that may have shifted with this report. Never
  // blocks the agent response.
  void evaluateWatchlists("host_reported").catch((err) => {
    console.error(
      "watchlist eval post-report failed",
      err instanceof Error ? err.message : String(err)
    );
  });

  return NextResponse.json({ ok: true, reportId });
}
