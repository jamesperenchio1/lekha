import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { getGoogleClient } from "./google-auth";
import { setPending, type PendingAction } from "@/lib/confirm";

export function buildCalendarTools(userId: string) {
  return {
    draft_calendar_event: tool({
      description:
        "Draft a Google Calendar event on the user's primary calendar. Does NOT create it yet — stores a draft and the user must reply YES to confirm. After calling this, your reply should restate the draft and ask for confirmation.",
      inputSchema: z.object({
        summary: z.string().min(1).max(200).describe("Event title"),
        startISO: z.string().describe("ISO 8601 start datetime"),
        endISO: z.string().describe("ISO 8601 end datetime"),
        description: z.string().max(2000).optional(),
        attendees: z.array(z.string().email()).max(20).optional(),
        location: z.string().max(200).optional(),
      }),
      execute: async ({ summary, startISO, endISO, description, attendees, location }) => {
        const action: PendingAction = {
          kind: "create_calendar_event",
          summary,
          startISO,
          endISO,
          description,
          attendees,
          location,
        };
        await setPending(userId, action);
        return {
          status: "draft_pending_confirmation" as const,
          draft: { summary, startISO, endISO, description, attendees, location },
          instruction:
            "Show the user the draft event details and ask them to reply YES to add it to their calendar (or describe edits).",
        };
      },
    }),

    list_upcoming_events: tool({
      description: "List the next few events on the user's primary calendar.",
      inputSchema: z.object({
        days: z.number().min(1).max(30).default(7),
      }),
      execute: async ({ days }) => {
        const auth = await getGoogleClient(userId);
        const calendar = google.calendar({ version: "v3", auth });
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
          events:
            r.data.items?.map((e) => ({
              summary: e.summary ?? "(no title)",
              start: e.start?.dateTime ?? e.start?.date ?? "",
              end: e.end?.dateTime ?? e.end?.date ?? "",
              location: e.location ?? null,
            })) ?? [],
        };
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
  },
): Promise<{ htmlLink: string | null }> {
  const auth = await getGoogleClient(userId);
  const calendar = google.calendar({ version: "v3", auth });
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
  return { htmlLink: r.data.htmlLink ?? null };
}
