import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { auditLog } from "@/lib/auditLog";
import { sendTestEmail } from "@/lib/sesClient";

/**
 * POST /api/admin/ses/test — send a test email to a body-provided
 * address. Updates SesConfig.lastTestAt / lastTestOk / lastTestError
 * so the admin page can render the last-test status inline.
 *
 * On failure returns 400 with the AWS error message verbatim — the
 * admin needs the underlying detail to fix the config.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PostBody {
  to?: unknown;
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
  if (!to || !EMAIL_RE.test(to)) {
    return NextResponse.json(
      { error: "valid recipient email required" },
      { status: 400 }
    );
  }

  try {
    const result = await sendTestEmail(to);
    await prisma.sesConfig.update({
      where: { name: "default" },
      data: {
        lastTestAt: new Date(),
        lastTestOk: true,
        lastTestError: null,
      },
    });
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "trigger",
      entityType: "ses_test",
      entityId: "default",
      summary: `SES test email sent to ${to}`,
    });
    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.sesConfig
      .update({
        where: { name: "default" },
        data: {
          lastTestAt: new Date(),
          lastTestOk: false,
          lastTestError: msg.slice(0, 500),
        },
      })
      .catch(() => {
        /* config row may not exist yet — surface the original error */
      });
    auditLog(req, {
      actorId: user.userId,
      actorEmail: user.email,
      action: "trigger",
      entityType: "ses_test",
      entityId: "default",
      summary: `SES test email FAILED to ${to}: ${msg.slice(0, 200)}`,
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
