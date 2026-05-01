import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { withGoogleClient } from "./with-google";

const PEOPLE_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

type Contact = {
  name: string;
  emails: string[];
  phones: string[];
};

function pluck(person: {
  names?: { displayName?: string | null }[] | null;
  emailAddresses?: { value?: string | null }[] | null;
  phoneNumbers?: { value?: string | null }[] | null;
}): Contact {
  return {
    name: person.names?.[0]?.displayName ?? "(no name)",
    emails: (person.emailAddresses ?? []).map((e) => e.value ?? "").filter(Boolean),
    phones: (person.phoneNumbers ?? []).map((p) => p.value ?? "").filter(Boolean),
  };
}

export function buildContactTools(userId: string) {
  return {
    contacts_search: tool({
      description:
        "Search the user's Google Contacts by name (or partial name / email). Returns name + email(s) + phone(s). Use this when the user says 'email mom' or 'text bob' instead of giving a literal address.",
      inputSchema: z.object({
        query: z.string().min(1).max(120),
        limit: z.number().int().min(1).max(20).default(8),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ query, limit, fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [PEOPLE_SCOPE], async ({ client }) => {
          const people = google.people({ version: "v1", auth: client });
          const r = await people.people.searchContacts({
            query,
            pageSize: limit,
            readMask: "names,emailAddresses,phoneNumbers",
          });
          const results = (r.data.results ?? [])
            .map((rr) => rr.person)
            .filter((p): p is NonNullable<typeof p> => Boolean(p))
            .map(pluck);
          // Also try "other contacts" (people you've corresponded with but not saved).
          if (results.length === 0) {
            const r2 = await people.otherContacts.search({
              query,
              pageSize: limit,
              readMask: "names,emailAddresses,phoneNumbers",
            });
            const r2results = (r2.data.results ?? [])
              .map((rr) => rr.person)
              .filter((p): p is NonNullable<typeof p> => Boolean(p))
              .map(pluck);
            return { ok: true as const, results: r2results, source: "otherContacts" as const };
          }
          return { ok: true as const, results, source: "contacts" as const };
        });
      },
    }),
  };
}
