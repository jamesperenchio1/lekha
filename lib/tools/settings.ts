import { z } from "zod";
import { tool } from "ai";
import { getSettings, updateSettings } from "@/lib/memory/settings";

const TZ_REGEX = /^[A-Za-z][A-Za-z_]*\/[A-Za-z][A-Za-z_]*(?:\/[A-Za-z][A-Za-z_]*)?$/;

function formatLead(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function buildSettingsTools(userId: string) {
  return {
    get_my_settings: tool({
      description:
        "Show the user's current preferences (timezone, location, language, daily briefing time, pre-meeting alert, etc.).",
      inputSchema: z.object({}),
      execute: async () => getSettings(userId),
    }),

    set_timezone: tool({
      description:
        "Set the user's IANA timezone (e.g. 'Asia/Bangkok', 'America/New_York', 'Europe/London'). Affects how times are shown in calendar drafts and morning briefings.",
      inputSchema: z.object({
        timezone: z.string().regex(TZ_REGEX, "must be an IANA timezone like 'Asia/Bangkok'"),
      }),
      execute: async ({ timezone }) => {
        try {
          // Validate by attempting to format with it.
          new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
        } catch {
          return { ok: false, error: `'${timezone}' isn't recognized. Use an IANA name.` };
        }
        const next = await updateSettings(userId, { timezone });
        return { ok: true, timezone: next.timezone };
      },
    }),

    set_location: tool({
      description:
        "Save the user's general location (e.g. 'Bangkok, Thailand'). Used to make weather/maps/web-search answers more relevant.",
      inputSchema: z.object({ location: z.string().min(2).max(120) }),
      execute: async ({ location }) => {
        await updateSettings(userId, { location });
        return { ok: true, location };
      },
    }),

    set_language: tool({
      description:
        "Pin a reply language (e.g. 'en', 'th'). Pass null to auto-match the user's message.",
      inputSchema: z.object({ language: z.string().nullable() }),
      execute: async ({ language }) => {
        await updateSettings(userId, { language });
        return { ok: true, language };
      },
    }),

    enable_morning_briefing: tool({
      description:
        "Turn on a daily push briefing at the given local time (HH:mm 24h). Includes weather, today's calendar, open tasks, and (if enabled) inbox highlights.",
      inputSchema: z.object({
        time: z.string().regex(/^\d{1,2}:\d{2}$/),
        include_inbox: z.boolean().default(false),
      }),
      execute: async ({ time, include_inbox }) => {
        await updateSettings(userId, {
          morningBriefingTime: time,
          inboxBriefingEnabled: include_inbox,
        });
        return { ok: true, morningBriefingTime: time, inboxBriefingEnabled: include_inbox };
      },
    }),

    disable_morning_briefing: tool({
      description: "Turn off the daily morning briefing.",
      inputSchema: z.object({}),
      execute: async () => {
        await updateSettings(userId, { morningBriefingTime: null });
        return { ok: true };
      },
    }),

    enable_pre_meeting_alerts: tool({
      description:
        "Push the user a heads-up at multiple intervals before each upcoming calendar event. Pass an array of minutes-before. Common picks: [1440, 60, 30] = 1 day, 1 hour, 30 min before. Pass [] to disable.",
      inputSchema: z.object({
        minutes_before: z
          .array(z.number().int().min(0).max(60 * 24 * 7))
          .max(6)
          .describe("Minutes-before-event to alert. e.g. [1440, 60, 30] for 1d/1h/30m. Empty array disables."),
      }),
      execute: async ({ minutes_before }) => {
        // Sort descending so cron sweep checks longest leads first.
        const sorted = [...minutes_before].sort((a, b) => b - a);
        await updateSettings(userId, { preMeetingLeads: sorted });
        return {
          ok: true,
          preMeetingLeads: sorted,
          note: sorted.length === 0 ? "Pre-meeting alerts disabled." : `Will push at ${sorted.map((m) => formatLead(m)).join(", ")} before each event.`,
        };
      },
    }),
  };
}
