import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { withGoogleClient } from "./with-google";
import { appendPending, type SendEmailAction } from "@/lib/confirm";

const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

type Headers = Record<string, string>;

function headerMap(headers: { name?: string | null; value?: string | null }[] | undefined): Headers {
  const out: Headers = {};
  for (const h of headers ?? []) {
    if (h.name && h.value) out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

function decodeBody(part: {
  body?: { data?: string | null; size?: number | null } | null;
  parts?: unknown;
  mimeType?: string | null;
}): string {
  // Walk for text/plain first, then text/html.
  const stack: any[] = [part];
  let plain = "";
  let html = "";
  while (stack.length) {
    const cur = stack.pop();
    if (cur?.parts) for (const p of cur.parts) stack.push(p);
    if (cur?.body?.data && cur.mimeType?.startsWith("text/")) {
      const decoded = Buffer.from(cur.body.data, "base64url").toString("utf8");
      if (cur.mimeType === "text/plain" && !plain) plain = decoded;
      else if (cur.mimeType === "text/html" && !html) html = decoded;
    }
  }
  if (plain) return plain;
  if (html) {
    // crude tag-strip
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

export function buildGmailInboxTools(userId: string) {
  return {
    gmail_search: tool({
      description:
        "Search the user's Gmail inbox using Gmail query syntax (e.g. 'from:bob is:unread', 'subject:invoice newer_than:7d'). Returns metadata + a short snippet for each hit.",
      inputSchema: z.object({
        query: z.string().min(1).max(300),
        limit: z.number().int().min(1).max(20).default(10),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ query, limit, fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [GMAIL_RO], async ({ client }) => {
          const gmail = google.gmail({ version: "v1", auth: client });
          const list = await gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: limit,
          });
          const ids = (list.data.messages ?? []).map((m) => m.id ?? "").filter(Boolean);
          const fetched = await Promise.all(
            ids.map((id) =>
              gmail.users.messages.get({
                userId: "me",
                id,
                format: "metadata",
                metadataHeaders: ["From", "To", "Subject", "Date"],
              }),
            ),
          );
          const messages = fetched.map((r) => {
            const h = headerMap(r.data.payload?.headers ?? undefined);
            return {
              id: r.data.id ?? "",
              threadId: r.data.threadId ?? "",
              from: h["from"] ?? "",
              to: h["to"] ?? "",
              subject: h["subject"] ?? "(no subject)",
              date: h["date"] ?? "",
              snippet: r.data.snippet ?? "",
              unread: (r.data.labelIds ?? []).includes("UNREAD"),
            };
          });
          return { ok: true as const, messages };
        });
      },
    }),

    gmail_read: tool({
      description:
        "Fetch the full plain-text body + headers of a specific Gmail message by id. Use after gmail_search to actually read the email.",
      inputSchema: z.object({
        id: z.string().min(1),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ id, fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [GMAIL_RO], async ({ client }) => {
          const gmail = google.gmail({ version: "v1", auth: client });
          const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });
          const h = headerMap(r.data.payload?.headers ?? undefined);
          const body = decodeBody(r.data.payload ?? {});
          return {
            ok: true as const,
            id: r.data.id ?? "",
            threadId: r.data.threadId ?? "",
            from: h["from"] ?? "",
            to: h["to"] ?? "",
            cc: h["cc"] ?? "",
            subject: h["subject"] ?? "",
            date: h["date"] ?? "",
            body: body.slice(0, 50_000),
            truncated: body.length > 50_000,
          };
        });
      },
    }),

    gmail_summarize_recent: tool({
      description:
        "Quick snapshot of the user's recent inbox — last N messages with subject + sender + snippet. Good for morning briefings or 'what's in my inbox'.",
      inputSchema: z.object({
        hours: z.number().int().min(1).max(168).default(24),
        unread_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(30).default(15),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ hours, unread_only, limit, fromEmail }) => {
        return withGoogleClient(userId, fromEmail, [GMAIL_RO], async ({ client }) => {
          const gmail = google.gmail({ version: "v1", auth: client });
          const q = [
            `newer_than:${Math.ceil(hours / 24) || 1}d`,
            unread_only ? "is:unread" : "",
            "category:primary",
          ]
            .filter(Boolean)
            .join(" ");
          const list = await gmail.users.messages.list({ userId: "me", q, maxResults: limit });
          const ids = (list.data.messages ?? []).map((m) => m.id ?? "").filter(Boolean);
          if (!ids.length) return { ok: true as const, messages: [] };
          const fetched = await Promise.all(
            ids.map((id) =>
              gmail.users.messages.get({
                userId: "me",
                id,
                format: "metadata",
                metadataHeaders: ["From", "Subject", "Date"],
              }),
            ),
          );
          return {
            ok: true as const,
            messages: fetched.map((r) => {
              const h = headerMap(r.data.payload?.headers ?? undefined);
              return {
                id: r.data.id,
                from: h["from"] ?? "",
                subject: h["subject"] ?? "(no subject)",
                date: h["date"] ?? "",
                snippet: r.data.snippet ?? "",
                unread: (r.data.labelIds ?? []).includes("UNREAD"),
              };
            }),
          };
        });
      },
    }),

    draft_gmail_reply: tool({
      description:
        "Draft a reply to a specific Gmail thread. Does NOT send — appends to the pending confirm queue exactly like draft_email. Pass the messageId of the email being replied to (from gmail_search/gmail_read).",
      inputSchema: z.object({
        in_reply_to_message_id: z.string().min(1),
        body: z.string().min(1).max(20_000),
        also_to: z.array(z.string().email()).max(20).optional().describe("Add extra to: recipients"),
        cc: z.array(z.string().email()).max(20).optional(),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ in_reply_to_message_id, body, also_to, cc, fromEmail }) => {
        type ReplyMeta = {
          from: string;
          subject: string;
          messageIdHdr: string;
          references: string;
          threadId: string;
        };
        const meta = await withGoogleClient(userId, fromEmail, [GMAIL_RO], async ({ client }): Promise<ReplyMeta> => {
          const gmail = google.gmail({ version: "v1", auth: client });
          const r = await gmail.users.messages.get({
            userId: "me",
            id: in_reply_to_message_id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Cc", "Subject", "Message-ID", "References"],
          });
          const h = headerMap(r.data.payload?.headers ?? undefined);
          return {
            from: h["from"] ?? "",
            subject: h["subject"] ?? "",
            messageIdHdr: h["message-id"] ?? "",
            references: h["references"] ?? "",
            threadId: r.data.threadId ?? "",
          };
        });
        if ("ok" in meta && meta.ok === false) return meta;
        const m = meta as ReplyMeta;

        const replySubject = /^re:\s*/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
        const fromAddr = extractEmail(m.from);
        const to = [fromAddr, ...(also_to ?? [])].filter(Boolean) as string[];

        const action: SendEmailAction & {
          inReplyToMessageIdHdr?: string;
          references?: string;
          threadId?: string;
        } = {
          kind: "send_email",
          to,
          cc,
          subject: replySubject,
          body,
          fromEmail,
          inReplyToMessageIdHdr: m.messageIdHdr,
          references: m.references,
          threadId: m.threadId,
        };
        await appendPending(userId, action as SendEmailAction);
        return {
          status: "draft_pending_confirmation" as const,
          draft: {
            replyingTo: { from: m.from, subject: m.subject, threadId: m.threadId },
            to,
            cc,
            subject: replySubject,
            body,
            fromEmail,
          },
        };
      },
    }),
  };
}

function extractEmail(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m?.[1] ?? addr).trim();
}
