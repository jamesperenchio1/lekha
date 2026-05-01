import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { getGoogleClient } from "./google-auth";
import { setPending, type CreateCalendarEventAction } from "@/lib/confirm";

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
        await setPending(userId, action);
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
        const { client } = await getGoogleClient(userId, fromEmail);
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
