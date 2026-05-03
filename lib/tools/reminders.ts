import { z } from "zod";
import { tool } from "ai";
import { Client as QStash } from "@upstash/qstash";
import { redis } from "@/lib/memory/redis";
import { env, hasQStash } from "@/lib/env";
import { localTimeToUtcCron } from "@/lib/cron";

const qstash = () => {
  if (!hasQStash()) throw new Error("QStash not configured");
  return new QStash({ token: env().QSTASH_TOKEN! });
};

type StoredReminder = {
  id: string;
  message: string;
  fireAt: number;
  qstashId: string;
  /** If set, this is a recurring reminder; the QStash id is a schedule, not a one-shot. */
  cron?: string;
};

const reminderKey = (userId: string, id: string) => `reminder:${userId}:${id}`;
const reminderListKey = (userId: string) => `reminder:${userId}:_list`;

export async function listReminders(userId: string): Promise<StoredReminder[]> {
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
          // Roll the set's TTL forward to ~14 months so it can never outlive
          // the longest possible reminder (1 year max) without housekeeping.
          await redis().expire(reminderListKey(userId), 60 * 60 * 24 * 400);
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
      description: "Cancel a pending (one-shot or recurring) reminder by its id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const r = await redis().get<StoredReminder>(reminderKey(userId, id));
        if (!r) return { ok: false, error: "Reminder not found" };
        try {
          if (r.cron) {
            await qstash().schedules.delete(r.qstashId);
          } else {
            await qstash().messages.delete(r.qstashId);
          }
        } catch {
          // already fired or deleted; continue
        }
        await redis().del(reminderKey(userId, id));
        await redis().srem(reminderListKey(userId), id);
        return { ok: true };
      },
    }),

    set_recurring_reminder: tool({
      description:
        "Schedule a recurring reminder (e.g. 'every weekday at 8am to take vitamins'). Pass the time in 24h HH:mm in the user's local timezone — the system converts to UTC before scheduling.",
      inputSchema: z.object({
        time: z.string().regex(/^\d{1,2}:\d{2}$/, "must be HH:mm"),
        message: z.string().min(1).max(500),
        timezone: z
          .string()
          .describe("IANA timezone like 'Asia/Bangkok'. Use the user's stored setting if known."),
        days: z
          .enum(["daily", "weekdays", "weekends"])
          .default("daily"),
      }),
      execute: async ({ time, message, timezone, days }) => {
        const cronTime = localTimeToUtcCron(time, timezone);
        if (!cronTime) return { ok: false, error: "Invalid time format" };
        const dayPart =
          days === "weekdays" ? "1-5" : days === "weekends" ? "0,6" : "*";
        // localTimeToUtcCron returns "M H * * *" — splice in the day-of-week.
        const parts = cronTime.split(" ");
        const cronUtc = `${parts[0]} ${parts[1]} * * ${dayPart}`;

        const id = crypto.randomUUID();
        const callbackUrl = `${env().APP_BASE_URL}/api/reminders/fire`;
        try {
          const sched = await qstash().schedules.create({
            destination: callbackUrl,
            cron: cronUtc,
            body: JSON.stringify({ userId, id, message, recurring: true }),
            headers: { "Content-Type": "application/json" },
          });
          const stored: StoredReminder = {
            id,
            message,
            fireAt: Date.now(), // not really used for recurring
            qstashId: sched.scheduleId,
            cron: cronUtc,
          };
          await redis().set(reminderKey(userId, id), stored);
          await redis().sadd(reminderListKey(userId), id);
          await redis().expire(reminderListKey(userId), 60 * 60 * 24 * 400);
          return { ok: true, id, cron: cronUtc, days };
        } catch (err) {
          console.error("[reminder] recurring schedule failed", err);
          return {
            ok: false,
            error: err instanceof Error ? err.message : "Failed to schedule recurring reminder",
          };
        }
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
