import {
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/sesSecret";

/**
 * Thin SES v2 wrapper.
 *
 * Reads `SesConfig.default` fresh from the DB on every send — admins
 * may rotate access keys at any time and we don't want a stale cached
 * client holding the old credentials. The cost is one indexed SELECT
 * per email; with notifications being a sparse, human-paced event,
 * this is fine.
 *
 * Errors propagate as-is so the caller (watchlist evaluator) can stamp
 * `Notification.emailError` and the SES test endpoint can return the
 * AWS error verbatim to the admin.
 */

const CONFIG_NAME = "default";

interface ResolvedConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fromAddress: string;
  replyTo: string | null;
}

async function loadConfig(): Promise<ResolvedConfig> {
  const row = await prisma.sesConfig.findUnique({
    where: { name: CONFIG_NAME },
  });
  if (!row || !row.enabled) {
    throw new Error("SES not configured");
  }
  if (
    !row.region ||
    !row.accessKeyId ||
    !row.secretAccessKeyCipher ||
    !row.secretAccessKeyIv ||
    !row.fromAddress
  ) {
    throw new Error("SES not configured");
  }
  let secretAccessKey: string;
  try {
    secretAccessKey = decryptSecret(
      row.secretAccessKeyIv,
      row.secretAccessKeyCipher
    );
  } catch (err) {
    throw new Error(
      `SES secret decrypt failed (ENCRYPTION_KEY rotated or prisma/.encryption-key missing? re-enter the SES secret): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return {
    region: row.region,
    accessKeyId: row.accessKeyId,
    secretAccessKey,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo,
  };
}

function buildClient(cfg: ResolvedConfig): SESv2Client {
  return new SESv2Client({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}

export interface SendEmailOptions {
  to: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
}

export async function sendEmail(
  opts: SendEmailOptions
): Promise<{ messageId: string }> {
  if (!opts.to.length) {
    throw new Error("sendEmail: at least one recipient required");
  }
  const cfg = await loadConfig();
  const client = buildClient(cfg);

  const cmd = new SendEmailCommand({
    FromEmailAddress: cfg.fromAddress,
    ReplyToAddresses: cfg.replyTo ? [cfg.replyTo] : undefined,
    Destination: { ToAddresses: opts.to },
    Content: {
      Simple: {
        Subject: { Data: opts.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: opts.textBody, Charset: "UTF-8" },
          ...(opts.htmlBody
            ? { Html: { Data: opts.htmlBody, Charset: "UTF-8" } }
            : {}),
        },
      },
    },
  });

  const res = await client.send(cmd);
  return { messageId: res.MessageId ?? "" };
}

export async function sendTestEmail(
  to: string
): Promise<{ messageId: string }> {
  return sendEmail({
    to: [to],
    subject: "Argus SES test",
    textBody:
      "This is a test email from Argus. If you received this, SES is configured correctly.",
    htmlBody:
      "<p>This is a test email from <strong>Argus</strong>.</p><p>If you received this, SES is configured correctly.</p>",
  });
}
