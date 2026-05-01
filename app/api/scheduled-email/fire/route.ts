import { NextResponse, type NextRequest } from "next/server";
import { Receiver } from "@upstash/qstash";
import { z } from "zod";
import { env, hasQStash } from "@/lib/env";
import { push, text as textMsg } from "@/lib/line/client";
import { consumeScheduledEmail } from "@/lib/tools/scheduled-email";
import { sendEmail } from "@/lib/tools/email";
import { logSent } from "@/lib/memory/sent-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  userId: z.string().min(1),
  id: z.string().min(1),
});

export async function POST(req: NextRequest) {
  if (!hasQStash()) return new NextResponse("not configured", { status: 503 });
  const raw = await req.text();
  const sig = req.headers.get("upstash-signature") ?? req.headers.get("Upstash-Signature");
  if (!sig) return new NextResponse("missing signature", { status: 401 });
  const receiver = new Receiver({
    currentSigningKey: env().QSTASH_CURRENT_SIGNING_KEY!,
    nextSigningKey: env().QSTASH_NEXT_SIGNING_KEY ?? env().QSTASH_CURRENT_SIGNING_KEY!,
  });
  try {
    const ok = await receiver.verify({
      signature: sig,
      body: raw,
      url: `${env().APP_BASE_URL}/api/scheduled-email/fire`,
    });
    if (!ok) return new NextResponse("invalid signature", { status: 401 });
  } catch {
    return new NextResponse("invalid signature", { status: 401 });
  }

  let body;
  try {
    body = Body.parse(JSON.parse(raw));
  } catch {
    return new NextResponse("bad body", { status: 400 });
  }

  const sched = await consumeScheduledEmail(body.userId, body.id);
  if (!sched) return NextResponse.json({ ok: true, skipped: true });

  try {
    const r = await sendEmail(body.userId, {
      kind: "send_email",
      to: sched.draft.to,
      cc: sched.draft.cc,
      bcc: sched.draft.bcc,
      subject: sched.draft.subject,
      body: sched.draft.body,
      fromEmail: sched.draft.fromEmail,
    });
    await logSent(body.userId, {
      kind: "email",
      summary: `[scheduled] ${sched.draft.subject} → ${sched.draft.to.join(", ")}`,
      detail: {
        to: sched.draft.to,
        cc: sched.draft.cc,
        subject: sched.draft.subject,
        from: r.from,
        scheduledAt: new Date(sched.scheduledForTs).toISOString(),
      },
    });
    await push(body.userId, [
      textMsg(`📤 Scheduled email sent: "${sched.draft.subject}" → ${sched.draft.to.join(", ")} (from ${r.from}).`),
    ]);
  } catch (err) {
    console.error("[scheduled-email] send failed", err);
    await push(body.userId, [
      textMsg(`⚠️ Scheduled email failed: "${sched.draft.subject}". ${err instanceof Error ? err.message : ""}`),
    ]);
  }

  return NextResponse.json({ ok: true });
}
