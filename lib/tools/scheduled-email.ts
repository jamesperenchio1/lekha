import { z } from "zod";
import { tool } from "ai";
import { redis } from "@/lib/memory/redis";
import { env, hasQStash } from "@/lib/env";
import { Client as QStash } from "@upstash/qstash";

type ScheduledEmail = {
  id: string;
  userId: string;
  scheduledForTs: number;
  qstashId: string;
  draft: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    fromEmail?: string;
  };
};

const qstash = () => new QStash({ token: env().QSTASH_TOKEN! });

const scheduledKey = (userId: string, id: string) => `sched_email:${userId}:${id}`;
const scheduledListKey = (userId: string) => `sched_email:${userId}:_list`;

export function buildScheduledEmailTools(userId: string) {
  return {
    schedule_email: tool({
      description:
        "Schedule an email to be sent at a future time. The email is composed now but actually sent later by a background job. Pass an ISO 8601 sendAt timestamp.",
      inputSchema: z.object({
        sendAt: z.string().describe("ISO 8601 datetime when the email should fire"),
        to: z.array(z.string().email()).min(1).max(50),
        cc: z.array(z.string().email()).max(50).optional(),
        bcc: z.array(z.string().email()).max(50).optional(),
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(20_000),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ sendAt, to, cc, bcc, subject, body, fromEmail }) => {
        if (!hasQStash()) return { ok: false, error: "Scheduling not configured" };
        const ts = new Date(sendAt).getTime();
        if (!Number.isFinite(ts)) return { ok: false, error: "Invalid sendAt datetime" };
        const delaySec = Math.floor((ts - Date.now()) / 1000);
        if (delaySec < 30) return { ok: false, error: "sendAt must be at least 30 seconds in the future" };
        if (delaySec > 60 * 60 * 24 * 365) return { ok: false, error: "Max 1 year ahead" };

        const id = crypto.randomUUID();
        const callbackUrl = `${env().APP_BASE_URL}/api/scheduled-email/fire`;
        const r = await qstash().publishJSON({
          url: callbackUrl,
          body: { userId, id },
          delay: delaySec,
        });
        const stored: ScheduledEmail = {
          id,
          userId,
          scheduledForTs: ts,
          qstashId: r.messageId,
          draft: { to, cc, bcc, subject, body, fromEmail },
        };
        await redis().set(scheduledKey(userId, id), stored, { ex: delaySec + 300 });
        await redis().sadd(scheduledListKey(userId), id);
        await redis().expire(scheduledListKey(userId), 60 * 60 * 24 * 400);
        return { ok: true, id, sendAt: new Date(ts).toISOString() };
      },
    }),

    list_scheduled_emails: tool({
      description: "List emails scheduled for future send.",
      inputSchema: z.object({}),
      execute: async () => {
        const ids = await redis().smembers(scheduledListKey(userId));
        const items = await Promise.all(ids.map((id) => redis().get<ScheduledEmail>(scheduledKey(userId, id))));
        return {
          scheduled: items
            .filter((x): x is ScheduledEmail => x !== null)
            .sort((a, b) => a.scheduledForTs - b.scheduledForTs)
            .map((s) => ({
              id: s.id,
              sendAt: new Date(s.scheduledForTs).toISOString(),
              subject: s.draft.subject,
              to: s.draft.to,
              cc: s.draft.cc,
            })),
        };
      },
    }),

    cancel_scheduled_email: tool({
      description: "Cancel a scheduled email by id (must be cancelled before its sendAt time).",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const s = await redis().get<ScheduledEmail>(scheduledKey(userId, id));
        if (!s) return { ok: false, error: "Scheduled email not found" };
        try {
          await qstash().messages.delete(s.qstashId);
        } catch {
          // already fired
        }
        await redis().del(scheduledKey(userId, id));
        await redis().srem(scheduledListKey(userId), id);
        return { ok: true };
      },
    }),
  };
}

export async function consumeScheduledEmail(userId: string, id: string): Promise<ScheduledEmail | null> {
  const s = await redis().get<ScheduledEmail>(scheduledKey(userId, id));
  if (!s) return null;
  await redis().del(scheduledKey(userId, id));
  await redis().srem(scheduledListKey(userId), id);
  return s;
}
