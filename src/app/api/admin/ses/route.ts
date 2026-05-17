import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import { encryptSecret } from "@/lib/sesSecret";
import type { SesConfigPublic } from "@/lib/types";

/**
 * GET /api/admin/ses — return the SES config minus the secret.
 *                       Includes `hasSecret: boolean` so the UI can
 *                       render "secret set" without ever round-tripping
 *                       the plaintext.
 * PUT /api/admin/ses — partial update. When `secretAccessKey` is
 *                       present it's re-encrypted via AES-256-GCM.
 *
 * Admin-only. Audit hooks: drop on every successful PUT.
 */

const CONFIG_NAME = "default";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGION_RE = /^[a-z]{2}-[a-z]+-\d$/;

async function loadOrCreate() {
  let row = await prisma.sesConfig.findUnique({
    where: { name: CONFIG_NAME },
  });
  if (!row) {
    row = await prisma.sesConfig.create({
      data: { name: CONFIG_NAME, enabled: false },
    });
  }
  return row;
}

function toPublic(row: Awaited<ReturnType<typeof loadOrCreate>>): SesConfigPublic {
  return {
    enabled: row.enabled,
    region: row.region,
    accessKeyId: row.accessKeyId,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo,
    hasSecret: Boolean(row.secretAccessKeyCipher && row.secretAccessKeyIv),
    lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  const row = await loadOrCreate();
  return NextResponse.json(toPublic(row));
}

interface PutBody {
  enabled?: unknown;
  region?: unknown;
  accessKeyId?: unknown;
  secretAccessKey?: unknown;
  fromAddress?: unknown;
  replyTo?: unknown;
}

export async function PUT(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};

  if ("enabled" in body) {
    data.enabled = Boolean(body.enabled);
  }
  if ("region" in body) {
    if (body.region == null || body.region === "") {
      data.region = null;
    } else if (typeof body.region === "string" && REGION_RE.test(body.region.trim())) {
      data.region = body.region.trim();
    } else {
      return NextResponse.json(
        { error: "region must look like ap-southeast-1" },
        { status: 400 }
      );
    }
  }
  if ("accessKeyId" in body) {
    if (body.accessKeyId == null || body.accessKeyId === "") {
      data.accessKeyId = null;
    } else if (typeof body.accessKeyId !== "string") {
      return NextResponse.json(
        { error: "accessKeyId must be a string" },
        { status: 400 }
      );
    } else {
      data.accessKeyId = body.accessKeyId.trim();
    }
  }
  if ("secretAccessKey" in body) {
    if (body.secretAccessKey == null || body.secretAccessKey === "") {
      data.secretAccessKeyCipher = null;
      data.secretAccessKeyIv = null;
    } else if (typeof body.secretAccessKey !== "string") {
      return NextResponse.json(
        { error: "secretAccessKey must be a string" },
        { status: 400 }
      );
    } else {
      const { iv, ciphertext } = encryptSecret(body.secretAccessKey);
      data.secretAccessKeyIv = iv;
      data.secretAccessKeyCipher = ciphertext;
    }
  }
  if ("fromAddress" in body) {
    if (body.fromAddress == null || body.fromAddress === "") {
      data.fromAddress = null;
    } else if (
      typeof body.fromAddress !== "string" ||
      !EMAIL_RE.test(body.fromAddress.trim())
    ) {
      return NextResponse.json(
        { error: "fromAddress must be a valid email" },
        { status: 400 }
      );
    } else {
      data.fromAddress = body.fromAddress.trim();
    }
  }
  if ("replyTo" in body) {
    if (body.replyTo == null || body.replyTo === "") {
      data.replyTo = null;
    } else if (
      typeof body.replyTo !== "string" ||
      !EMAIL_RE.test(body.replyTo.trim())
    ) {
      return NextResponse.json(
        { error: "replyTo must be a valid email" },
        { status: 400 }
      );
    } else {
      data.replyTo = body.replyTo.trim();
    }
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "no recognised fields to update" },
      { status: 400 }
    );
  }

  await loadOrCreate();
  const updated = await prisma.sesConfig.update({
    where: { name: CONFIG_NAME },
    data,
  });

  auditLog(req, {
    actorId: user.userId,
    actorEmail: user.email,
    action: "update",
    entityType: "ses_config",
    entityId: CONFIG_NAME,
    summary: `update SES config (enabled=${updated.enabled}, region=${updated.region ?? "—"}, from=${updated.fromAddress ?? "—"})`,
  });

  return NextResponse.json(toPublic(updated));
}
