import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { getGoogleClient } from "./google-auth";

type DriveFileLite = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink: string | null;
  owners: string[];
};

function summarize(file: {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  modifiedTime?: string | null;
  webViewLink?: string | null;
  owners?: { displayName?: string | null; emailAddress?: string | null }[] | null;
}): DriveFileLite {
  return {
    id: file.id ?? "",
    name: file.name ?? "(unnamed)",
    mimeType: file.mimeType ?? "",
    modifiedTime: file.modifiedTime ?? "",
    webViewLink: file.webViewLink ?? null,
    owners:
      file.owners?.map((o) => o.emailAddress ?? o.displayName ?? "?").filter(Boolean) ?? [],
  };
}

export function buildDriveTools(userId: string) {
  return {
    drive_search: tool({
      description:
        "Search the user's Google Drive. Pass a natural language query and it will be matched against file names and full-text content. Returns metadata + share links. Use this when the user asks about a Drive file by description ('that doc about X').",
      inputSchema: z.object({
        query: z.string().min(2).max(200),
        limit: z.number().min(1).max(20).default(8),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ query, limit, fromEmail }) => {
        const { client } = await getGoogleClient(userId, fromEmail, [
          "https://www.googleapis.com/auth/drive",
        ]);
        const drive = google.drive({ version: "v3", auth: client });
        // Combine name and fullText so semantic-ish hits work too.
        const escaped = query.replace(/'/g, "\\'");
        const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`;
        const r = await drive.files.list({
          q,
          pageSize: limit,
          fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName))",
          orderBy: "modifiedTime desc",
        });
        return { files: (r.data.files ?? []).map(summarize) };
      },
    }),

    drive_list_recent: tool({
      description:
        "List the user's most recently modified Drive files. Use when the user says 'what did I work on recently' or wants a snapshot.",
      inputSchema: z.object({
        limit: z.number().min(1).max(20).default(10),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ limit, fromEmail }) => {
        const { client } = await getGoogleClient(userId, fromEmail, [
          "https://www.googleapis.com/auth/drive",
        ]);
        const drive = google.drive({ version: "v3", auth: client });
        const r = await drive.files.list({
          q: "trashed = false",
          pageSize: limit,
          orderBy: "modifiedTime desc",
          fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName))",
        });
        return { files: (r.data.files ?? []).map(summarize) };
      },
    }),

    drive_get_link: tool({
      description:
        "Get the share link for a specific Drive file by its ID. Useful as a follow-up after drive_search/drive_list_recent.",
      inputSchema: z.object({
        fileId: z.string().min(1),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ fileId, fromEmail }) => {
        const { client } = await getGoogleClient(userId, fromEmail, [
          "https://www.googleapis.com/auth/drive",
        ]);
        const drive = google.drive({ version: "v3", auth: client });
        const r = await drive.files.get({
          fileId,
          fields: "id,name,webViewLink,mimeType",
        });
        return {
          id: r.data.id,
          name: r.data.name,
          mimeType: r.data.mimeType,
          link: r.data.webViewLink,
        };
      },
    }),

    drive_read_text: tool({
      description:
        "Read the text content of a Drive file. Works best on Google Docs (auto-converts to plain text), and on plain-text/markdown/CSV files. Returns up to ~50KB of text. Use after a search to actually read a doc.",
      inputSchema: z.object({
        fileId: z.string().min(1),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ fileId, fromEmail }) => {
        const { client } = await getGoogleClient(userId, fromEmail, [
          "https://www.googleapis.com/auth/drive",
        ]);
        const drive = google.drive({ version: "v3", auth: client });
        const meta = await drive.files.get({
          fileId,
          fields: "id,name,mimeType",
        });
        const mime = meta.data.mimeType ?? "";
        let text = "";
        if (mime === "application/vnd.google-apps.document") {
          const r = await drive.files.export(
            { fileId, mimeType: "text/plain" },
            { responseType: "text" },
          );
          text = String(r.data ?? "");
        } else if (
          mime.startsWith("text/") ||
          mime === "application/json" ||
          mime === "application/xml"
        ) {
          const r = await drive.files.get(
            { fileId, alt: "media" },
            { responseType: "text" },
          );
          text = String(r.data ?? "");
        } else {
          return {
            ok: false,
            error: `Can't read mime type "${mime}" as text. Try drive_get_link for the share URL instead.`,
            name: meta.data.name,
          };
        }
        const truncated = text.length > 50_000;
        return {
          ok: true,
          name: meta.data.name,
          mimeType: mime,
          truncated,
          text: text.slice(0, 50_000),
        };
      },
    }),
  };
}
