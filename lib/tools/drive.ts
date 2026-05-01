import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { withGoogleClient } from "./with-google";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

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
        "Search the user's Google Drive. Pass a natural language query and it will be matched against file names AND full-text content. Returns metadata + share links. Use this when the user names a file by description ('that doc about X') or by full/partial filename.",
      inputSchema: z.object({
        query: z.string().min(2).max(200),
        limit: z.number().min(1).max(20).default(8),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ query, limit, fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [DRIVE_SCOPE], async ({ client }) => {
          const drive = google.drive({ version: "v3", auth: client });
          const escaped = query.replace(/'/g, "\\'");
          const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`;
          const r = await drive.files.list({
            q,
            pageSize: limit,
            fields:
              "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName))",
            orderBy: "modifiedTime desc",
          });
          return { ok: true as const, files: (r.data.files ?? []).map(summarize) };
        });
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
        return withGoogleClient(userId, fromEmail, [DRIVE_SCOPE], async ({ client }) => {
          const drive = google.drive({ version: "v3", auth: client });
          const r = await drive.files.list({
            q: "trashed = false",
            pageSize: limit,
            orderBy: "modifiedTime desc",
            fields:
              "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName))",
          });
          return { ok: true as const, files: (r.data.files ?? []).map(summarize) };
        });
      },
    }),

    drive_get_link: tool({
      description:
        "Get the share link for a specific Drive file by its ID. Use as a follow-up after drive_search/drive_list_recent.",
      inputSchema: z.object({
        fileId: z.string().min(1),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ fileId, fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [DRIVE_SCOPE], async ({ client }) => {
          const drive = google.drive({ version: "v3", auth: client });
          const r = await drive.files.get({
            fileId,
            fields: "id,name,webViewLink,mimeType",
          });
          return {
            ok: true as const,
            id: r.data.id,
            name: r.data.name,
            mimeType: r.data.mimeType,
            link: r.data.webViewLink,
          };
        });
      },
    }),

    drive_read_text: tool({
      description:
        "Read the text content of a Drive file. Works on Google Docs (auto-converts to plain text) and on plain-text/markdown/CSV files. Returns up to ~50KB. Use after a search to actually read a doc.",
      inputSchema: z.object({
        fileId: z.string().min(1),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ fileId, fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [DRIVE_SCOPE], async ({ client }) => {
          const drive = google.drive({ version: "v3", auth: client });
          const meta = await drive.files.get({ fileId, fields: "id,name,mimeType" });
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
              ok: false as const,
              error: `Can't read mime type "${mime}" as text. Try drive_get_link for the share URL instead.`,
              name: meta.data.name,
            };
          }
          const truncated = text.length > 50_000;
          return {
            ok: true as const,
            name: meta.data.name,
            mimeType: mime,
            truncated,
            text: text.slice(0, 50_000),
          };
        });
      },
    }),
  };
}
