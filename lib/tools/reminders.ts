import { z } from "zod";
import { tool } from "ai";
import { Client as QStash } from "@upstash/qstash";
import { redis } from "@/lib/memory/redis";
import { env, hasQStash } from "@/lib/env";

const qstash = () => {
  if (!hasQStash()) throw new Error("QStash not configured");
  return new QStash({ token: env().QSTASH_TOKEN! });
};

type StoredReminder = {
  id: string;
  message: string;
  fireAt: number;
  qstashId: string;
};

const reminderKey = (userId: string, id: string) => `reminder:${userId}:${id}`;
const reminderListKey = (userId: string) => `reminder:${userId}:_list`;

async function listReminders(userId: string): Promise<StoredReminder[]> {
  const ids = await redis().smembers(reminderListKey(userId));
  if (!ids.length) return [];
  const items = await Promise.all(
    ids.map((id) => redis().get<StoredReminder>(reminderKey(userId, id))),
  );
  return items.filter((x): x is StoredReminder => x !== null).sort((a, b) => a.fireAt - b.fireAt);
}

export function buildReminderTools(userId: string) {
  return {
    set_reminder: tool({
      description:
        "Schedule a reminder. Use when the user asks you to remind them about something at a future time. Pass an ISO 8601 timestamp in their local time zone if known, otherwise UTC.",
      inputSchema: z.object({
        when: z
          .string()
          .describe("ISO 8601 datetime when the reminder should fire (e.g. 2026-05-02T15:00:00+07:00)"),
        message: z.string().min(1).max(500).describe("What to remind the user about, in their voice (e.g. 'call mom')"),
      }),
      execute: async ({ when, message }) => {
        const fireAt = new Date(when).getTime();
        if (!Number.isFinite(fireAt)) {
          console.warn("[reminder] invalid when:", when);
          return { ok: false, error: `Invalid datetime "${when}". Pass an ISO 8601 string.` };
        }
        const delaySec = Math.floor((fireAt - Date.now()) / 1000);
        if (delaySec < 1) {
          return { ok: false, error: `Reminder time is in the past (${new Date(fireAt).toISOString()}).` };
        }
        if (delaySec > 60 * 60 * 24 * 365) return { ok: false, error: "Max 1 year ahead" };

        const id = crypto.randomUUID();
        const callbackUrl = `${env().APP_BASE_URL}/api/reminders/fire`;
        try {
          const res = await qstash().publishJSON({
            url: callbackUrl,
            body: { userId, id, message },
            delay: delaySec,
          });
          const stored: StoredReminder = {
            id,
            message,
            fireAt,
            qstashId: res.messageId,
          };
          await redis().set(reminderKey(userId, id), stored, { ex: delaySec + 60 });
          await redis().sadd(reminderListKey(userId), id);
          console.log("[reminder] scheduled", { userId, id, fireAt: new Date(fireAt).toISOString(), delaySec });
          return { ok: true, id, fireAt: new Date(fireAt).toISOString() };
        } catch (err) {
          console.error("[reminder] qstash/redis failed", err);
          return {
            ok: false,
            error: err instanceof Error ? err.message : "Failed to schedule reminder",
          };
        }
      },
    }),

    list_reminders: tool({
      description: "List the user's pending reminders.",
      inputSchema: z.object({}),
      execute: async () => {
        const all = await listReminders(userId);
        return {
          reminders: all.map((r) => ({
            id: r.id,
            message: r.message,
            fireAt: new Date(r.fireAt).toISOString(),
          })),
        };
      },
    }),

    cancel_reminder: tool({
      description: "Cancel a pending reminder by its id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const r = await redis().get<StoredReminder>(reminderKey(userId, id));
        if (!r) return { ok: false, error: "Reminder not found" };
        try {
          await qstash().messages.delete(r.qstashId);
        } catch {
          // already fired or deleted; continue
        }
        await redis().del(reminderKey(userId, id));
        await redis().srem(reminderListKey(userId), id);
        return { ok: true };
      },
    }),
  };
}

export async function consumeReminder(userId: string, id: string): Promise<StoredReminder | null> {
  const r = await redis().get<StoredReminder>(reminderKey(userId, id));
  if (!r) return null;
  await redis().del(reminderKey(userId, id));
  await redis().srem(reminderListKey(userId), id);
  return r;
}
