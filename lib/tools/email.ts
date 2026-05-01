import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { withGoogleClient } from "./with-google";
import { getGoogleClient } from "./google-auth";
import { appendPending, type SendEmailAction } from "@/lib/confirm";
import { listRecentMedia, clearRecentMedia } from "@/lib/memory/recent-media";
import { getMessageContent } from "@/lib/line/client";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export function buildEmailTools(userId: string) {
  return {
    draft_email: tool({
      description:
        "Draft an email from one of the user's connected Gmail accounts. Does NOT send — appends to the pending confirm queue. Pass arrays for to/cc/bcc. Attach Drive files via `attachments`. Attach files the user just sent in LINE (image/video/audio/document) via `attach_recent_media: true` (attaches ALL staged) or `attach_recent_media_indexes: [1,3]` (1-indexed cherry-pick from oldest).",
      inputSchema: z.object({
        to: z.array(z.string().email()).min(1).max(50),
        cc: z.array(z.string().email()).max(50).optional(),
        bcc: z.array(z.string().email()).max(50).optional(),
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(20_000),
        fromEmail: z
          .string()
          .email()
          .optional()
          .describe("Which connected Gmail account to send from. Omit for active."),
        attachments: z
          .array(
            z.object({
              fileId: z.string().min(1),
              fromEmail: z.string().email().optional(),
            }),
          )
          .max(10)
          .optional()
          .describe("Drive file IDs to attach. Find IDs via drive_search first."),
        attach_recent_media: z
          .boolean()
          .optional()
          .describe(
            "Attach ALL files the user has recently sent in LINE (within ~30 min, up to 10). Mutually exclusive with attach_recent_media_indexes.",
          ),
        attach_recent_media_indexes: z
          .array(z.number().int().min(1))
          .max(10)
          .optional()
          .describe(
            "1-indexed positions of staged LINE files to attach (oldest is 1). Use when the user only wants some of the staged files.",
          ),
        attach_recent_media_filenames: z
          .array(z.string().max(120))
          .max(10)
          .optional()
          .describe(
            "Optional filename overrides aligned to the SAME order as attach_recent_media_indexes (or to all staged items if attach_recent_media is true). Empty string means keep default.",
          ),
      }),
      execute: async ({
        to, cc, bcc, subject, body, fromEmail, attachments,
        attach_recent_media, attach_recent_media_indexes, attach_recent_media_filenames,
      }) => {
        const wantsMedia =
          attach_recent_media === true ||
          (attach_recent_media_indexes && attach_recent_media_indexes.length > 0);

        if (wantsMedia) {
          const staged = await listRecentMedia(userId);
          if (staged.length === 0) {
            return {
              ok: false as const,
              error:
                "No LINE media is currently staged. Ask the user to send the file(s) in LINE; I keep them for ~30 min.",
            };
          }
          if (attach_recent_media_indexes) {
            const max = staged.length;
            const bad = attach_recent_media_indexes.filter((i) => i < 1 || i > max);
            if (bad.length) {
              return {
                ok: false as const,
                error: `Invalid attach_recent_media_indexes ${bad.join(",")}. Only 1..${max} are staged.`,
              };
            }
          }
        }

        const action: SendEmailAction = {
          kind: "send_email",
          to, cc, bcc, subject, body, fromEmail, attachments,
          attachRecentMedia: attach_recent_media,
          attachRecentMediaIndexes: attach_recent_media_indexes,
          attachRecentMediaFilenames: attach_recent_media_filenames,
        };
        await appendPending(userId, action);
        return {
          status: "draft_pending_confirmation" as const,
          draft: {
            to, cc, bcc, subject, body, fromEmail, attachments,
            attach_recent_media, attach_recent_media_indexes, attach_recent_media_filenames,
          },
          instruction:
            "The system shows the verbatim draft + attachment list to the user. Don't paraphrase the body.",
        };
      },
    }),
  };
}

/** Actually send a previously-confirmed email. Fetches Drive + LINE media at send time. */
export async function sendEmail(
  userId: string,
  args: SendEmailAction,
): Promise<{ from: string }> {
  const { client, email: from } = await getGoogleClient(userId, args.fromEmail, [GMAIL_SCOPE]);
  const gmail = google.gmail({ version: "v1", auth: client });

  const fetched: FetchedAttachment[] = [];

  for (const att of args.attachments ?? []) {
    fetched.push(await fetchDriveFile(userId, att.fileId, att.fromEmail));
  }

  let usedRecentMedia = false;
  if (args.attachRecentMedia || args.attachRecentMediaIndexes?.length) {
    const staged = await listRecentMedia(userId);
    if (staged.length === 0) {
      throw new Error("Recent LINE media expired before send. Resend the file(s) and retry.");
    }
    const targets: { item: typeof staged[number]; idx: number }[] = [];
    if (args.attachRecentMediaIndexes?.length) {
      for (const oneBased of args.attachRecentMediaIndexes) {
        const idx = oneBased - 1;
        if (idx < 0 || idx >= staged.length) {
          throw new Error(`Staged media index ${oneBased} no longer valid (only ${staged.length} now).`);
        }
        targets.push({ item: staged[idx]!, idx });
      }
    } else {
      staged.forEach((item, idx) => targets.push({ item, idx }));
    }

    for (let i = 0; i < targets.length; i++) {
      const { item } = targets[i]!;
      const { bytes, contentType } = await getMessageContent(item.messageId);
      const overrideName = args.attachRecentMediaFilenames?.[i];
      const filename =
        (overrideName && overrideName.length > 0 ? overrideName : null) ??
        item.fileName ??
        defaultFilename(item.kind, contentType);
      fetched.push({ filename, mimeType: contentType, bytes });
    }
    usedRecentMedia = true;
  }

  const raw = buildRawMime({
    from,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    body: args.body,
    attachments: fetched,
  });

  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  // Once successfully sent with staged media, clear the staged list so the
  // user doesn't accidentally re-attach the same files in the next email.
  if (usedRecentMedia) await clearRecentMedia(userId);

  return { from };
}

type FetchedAttachment = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

async function fetchDriveFile(
  userId: string,
  fileId: string,
  fromEmail: string | undefined,
): Promise<FetchedAttachment> {
  const result = await withGoogleClient(userId, fromEmail, [DRIVE_SCOPE], async ({ client }) => {
    const drive = google.drive({ version: "v3", auth: client });
    const meta = await drive.files.get({ fileId, fields: "id,name,mimeType" });
    const name = meta.data.name ?? `file-${fileId}`;
    const mime = meta.data.mimeType ?? "application/octet-stream";

    const exportMap: Record<string, { mime: string; ext: string }> = {
      "application/vnd.google-apps.document": { mime: "application/pdf", ext: ".pdf" },
      "application/vnd.google-apps.spreadsheet": {
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ext: ".xlsx",
      },
      "application/vnd.google-apps.presentation": {
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ext: ".pptx",
      },
    };
    if (exportMap[mime]) {
      const exp = exportMap[mime]!;
      const r = await drive.files.export(
        { fileId, mimeType: exp.mime },
        { responseType: "arraybuffer" },
      );
      return {
        filename: name.endsWith(exp.ext) ? name : `${name}${exp.ext}`,
        mimeType: exp.mime,
        bytes: new Uint8Array(r.data as ArrayBuffer),
      };
    }
    const r = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    return { filename: name, mimeType: mime, bytes: new Uint8Array(r.data as ArrayBuffer) };
  });

  if ("ok" in result && result.ok === false) {
    throw new Error(
      `Couldn't fetch Drive attachment ${fileId}: ${
        ("reason" in result && typeof result.reason === "string" && result.reason) ||
        ("message" in result && typeof result.message === "string" && result.message) ||
        "unknown error"
      }`,
    );
  }
  return result as FetchedAttachment;
}

function buildRawMime(opts: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments: FetchedAttachment[];
}): string {
  const baseHeaders = [
    `From: ${opts.from}`,
    `To: ${opts.to.join(", ")}`,
    ...(opts.cc?.length ? [`Cc: ${opts.cc.join(", ")}`] : []),
    ...(opts.bcc?.length ? [`Bcc: ${opts.bcc.join(", ")}`] : []),
    "MIME-Version: 1.0",
    `Subject: ${encodeHeader(opts.subject)}`,
  ];

  if (!opts.attachments.length) {
    const headers = [...baseHeaders, "Content-Type: text/plain; charset=utf-8"].join("\r\n");
    return Buffer.from(`${headers}\r\n\r\n${opts.body}`, "utf8").toString("base64url");
  }

  const boundary = `lekha_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const parts: string[] = [];
  parts.push(`--${boundary}`);
  parts.push("Content-Type: text/plain; charset=utf-8");
  parts.push("Content-Transfer-Encoding: 7bit");
  parts.push("");
  parts.push(opts.body);

  for (const att of opts.attachments) {
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.mimeType}; name="${escapeMimeHeaderValue(att.filename)}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(
      `Content-Disposition: attachment; filename="${escapeMimeHeaderValue(att.filename)}"`,
    );
    parts.push("");
    parts.push(chunkBase64(Buffer.from(att.bytes).toString("base64")));
  }
  parts.push(`--${boundary}--`);

  const headers = [
    ...baseHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join("\r\n");
  const message = `${headers}\r\n\r\n${parts.join("\r\n")}`;
  return Buffer.from(message, "utf8").toString("base64url");
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
function escapeMimeHeaderValue(s: string): string {
  return s.replace(/"/g, "'").replace(/[\r\n]/g, " ").slice(0, 200);
}
function chunkBase64(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join("\r\n");
}
function defaultFilename(kind: "image" | "video" | "audio" | "file", mime: string): string {
  const ext = mimeToExt(mime);
  return ext ? `${kind}${ext}` : kind;
}
function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
  if (m === "image/png") return ".png";
  if (m === "image/gif") return ".gif";
  if (m === "image/webp") return ".webp";
  if (m === "image/heic") return ".heic";
  if (m === "video/mp4") return ".mp4";
  if (m === "video/quicktime") return ".mov";
  if (m === "video/webm") return ".webm";
  if (m === "audio/m4a" || m === "audio/x-m4a" || m === "audio/mp4") return ".m4a";
  if (m === "audio/mpeg" || m === "audio/mp3") return ".mp3";
  if (m === "audio/wav" || m === "audio/x-wav") return ".wav";
  if (m === "audio/ogg") return ".ogg";
  if (m === "application/pdf") return ".pdf";
  if (m === "application/zip") return ".zip";
  return "";
}
