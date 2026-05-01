import { z } from "zod";
import { tool } from "ai";
import { listSent } from "@/lib/memory/sent-log";

export function buildSentHistoryTools(userId: string) {
  return {
    sent_history: tool({
      description:
        "Look up things the bot has actually sent on the user's behalf — emails, calendar events, reminders that fired. Filter by kind, time window, or recipient. Use when the user asks 'what did I send to bob today' or 'when did we email mom about the cert'.",
      inputSchema: z.object({
        kind: z.enum(["email", "calendar_event", "reminder_set"]).optional(),
        sinceHours: z.number().int().min(1).max(24 * 30).optional().default(24),
        recipient_contains: z.string().min(1).max(120).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: async ({ kind, sinceHours, recipient_contains, limit }) => {
        const sinceTs = Date.now() - sinceHours * 60 * 60 * 1000;
        let entries = await listSent(userId, { kind, sinceTs, limit });
        if (recipient_contains) {
          const q = recipient_contains.toLowerCase();
          entries = entries.filter((e) => {
            const t = (e.detail?.to as string[] | undefined)?.join(",").toLowerCase() ?? "";
            const c = (e.detail?.cc as string[] | undefined)?.join(",").toLowerCase() ?? "";
            const att = (e.detail?.attendees as string[] | undefined)?.join(",").toLowerCase() ?? "";
            return t.includes(q) || c.includes(q) || att.includes(q);
          });
        }
        return { entries };
      },
    }),
  };
}
