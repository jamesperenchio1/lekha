import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { getGoogleClient } from "./google-auth";
import { withGoogleClient } from "./with-google";
import { appendPending, type CreateCalendarEventAction } from "@/lib/confirm";

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function brief(e: {
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  location?: string | null;
  attendees?: { email?: string | null }[] | null;
}) {
  return {
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location ?? null,
    attendees: e.attendees?.map((a) => a.email ?? "").filter(Boolean) ?? [],
  };
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildCalendarTools(userId: string) {
  return {
    draft_calendar_event: tool({
      description:
        "Draft a Google Calendar event on the user's primary calendar. Does NOT create it — stores a draft and the user must reply YES. The system will render the verbatim draft to the user; don't paraphrase.",
      inputSchema: z.object({
        summary: z.string().min(1).max(200).describe("Event title"),
        startISO: z.string().describe("ISO 8601 start datetime"),
        endISO: z.string().describe("ISO 8601 end datetime"),
        description: z.string().max(2000).optional(),
        attendees: z.array(z.string().email()).max(20).optional(),
        location: z.string().max(200).optional(),
        fromEmail: z
          .string()
          .email()
          .optional()
          .describe("Which connected Google account's calendar to add to. Omit for active."),
      }),
      execute: async ({ summary, startISO, endISO, description, attendees, location, fromEmail }) => {
        const action: CreateCalendarEventAction = {
          kind: "create_calendar_event",
          summary,
          startISO,
          endISO,
          description,
          attendees,
          location,
          fromEmail,
        };
        await appendPending(userId, action);
        return {
          status: "draft_pending_confirmation" as const,
          draft: { summary, startISO, endISO, description, attendees, location, fromEmail },
        };
      },
    }),

    list_upcoming_events: tool({
      description: "List the next few events on the user's primary calendar.",
      inputSchema: z.object({
        days: z.number().min(1).max(30).default(7),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ days, fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [CAL_SCOPE], async ({ client }) => {
          const calendar = google.calendar({ version: "v3", auth: client });
          const now = new Date();
          const max = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
          const r = await calendar.events.list({
            calendarId: "primary",
            timeMin: now.toISOString(),
            timeMax: max.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 10,
          });
          return {
            ok: true as const,
            events:
              r.data.items?.map((e) => ({
                summary: e.summary ?? "(no title)",
                start: e.start?.dateTime ?? e.start?.date ?? "",
                end: e.end?.dateTime ?? e.end?.date ?? "",
                location: e.location ?? null,
              })) ?? [],
          };
        });
      },
    }),

    calendar_today: tool({
      description: "Quick today-view of the user's calendar — every event today with start/end times.",
      inputSchema: z.object({ fromEmail: z.string().email().optional() }),
      execute: async ({ fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [CAL_SCOPE], async ({ client }) => {
          const calendar = google.calendar({ version: "v3", auth: client });
          const start = new Date(); start.setHours(0, 0, 0, 0);
          const end = new Date();   end.setHours(23, 59, 59, 999);
          const r = await calendar.events.list({
            calendarId: "primary",
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 25,
          });
          return {
            ok: true as const,
            events: r.data.items?.map(brief) ?? [],
          };
        });
      },
    }),

    calendar_week: tool({
      description: "Week-view of upcoming calendar events (next 7 days). Use for 'what's my week look like' / 'organize my calendar' questions.",
      inputSchema: z.object({ fromEmail: z.string().email().optional() }),
      execute: async ({ fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [CAL_SCOPE], async ({ client }) => {
          const calendar = google.calendar({ version: "v3", auth: client });
          const start = new Date();
          const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
          const r = await calendar.events.list({
            calendarId: "primary",
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 50,
          });
          return {
            ok: true as const,
            events: r.data.items?.map(brief) ?? [],
          };
        });
      },
    }),

    calendar_find_free_time: tool({
      description: "Find free time slots on the user's calendar within a date range. Use for 'when am I free' / 'find me 1h slots tomorrow' / scheduling negotiations.",
      inputSchema: z.object({
        startISO: z.string().describe("Window start (ISO 8601)"),
        endISO: z.string().describe("Window end (ISO 8601)"),
        slotMinutes: z.number().int().min(15).max(480).default(30).describe("Required slot duration in minutes"),
        workdayStartHour: z.number().int().min(0).max(23).default(9),
        workdayEndHour: z.number().int().min(1).max(24).default(18),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ startISO, endISO, slotMinutes, workdayStartHour, workdayEndHour, fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [CAL_SCOPE], async ({ client }) => {
          const calendar = google.calendar({ version: "v3", auth: client });
          const r = await calendar.freebusy.query({
            requestBody: {
              timeMin: startISO,
              timeMax: endISO,
              items: [{ id: "primary" }],
            },
          });
          const busy = (r.data.calendars?.primary?.busy ?? []).map((b) => ({
            start: new Date(b.start ?? "").getTime(),
            end: new Date(b.end ?? "").getTime(),
          }));
          // Walk the window day-by-day, intersect with workday hours, subtract busy ranges.
          const slots: { startISO: string; endISO: string; minutes: number }[] = [];
          const winStart = new Date(startISO).getTime();
          const winEnd = new Date(endISO).getTime();
          for (let dayStart = startOfDay(winStart); dayStart < winEnd; dayStart += 24 * 60 * 60 * 1000) {
            const day = new Date(dayStart);
            const wStart = new Date(day); wStart.setHours(workdayStartHour, 0, 0, 0);
            const wEnd = new Date(day); wEnd.setHours(workdayEndHour, 0, 0, 0);
            let cursor = Math.max(winStart, wStart.getTime());
            const dayEnd = Math.min(winEnd, wEnd.getTime());
            const busyToday = busy
              .filter((b) => b.end > cursor && b.start < dayEnd)
              .sort((a, b) => a.start - b.start);
            for (const b of busyToday) {
              if (b.start - cursor >= slotMinutes * 60_000) {
                slots.push({
                  startISO: new Date(cursor).toISOString(),
                  endISO: new Date(b.start).toISOString(),
                  minutes: Math.round((b.start - cursor) / 60_000),
                });
              }
              cursor = Math.max(cursor, b.end);
            }
            if (dayEnd - cursor >= slotMinutes * 60_000) {
              slots.push({
                startISO: new Date(cursor).toISOString(),
                endISO: new Date(dayEnd).toISOString(),
                minutes: Math.round((dayEnd - cursor) / 60_000),
              });
            }
          }
          return { ok: true as const, slots: slots.slice(0, 20) };
        });
      },
    }),
  };
}

/** Actually create a previously-confirmed calendar event. */
export async function createCalendarEvent(
  userId: string,
  args: {
    summary: string;
    startISO: string;
    endISO: string;
    description?: string;
    attendees?: string[];
    location?: string;
    fromEmail?: string;
  },
): Promise<{ htmlLink: string | null; from: string }> {
  const { client, email: from } = await getGoogleClient(userId, args.fromEmail);
  const calendar = google.calendar({ version: "v3", auth: client });
  const r = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: args.summary,
      description: args.description,
      location: args.location,
      start: { dateTime: args.startISO },
      end: { dateTime: args.endISO },
      attendees: args.attendees?.map((email) => ({ email })),
    },
    sendUpdates: args.attendees?.length ? "all" : "none",
  });
  return { htmlLink: r.data.htmlLink ?? null, from };
}
