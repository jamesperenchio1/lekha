import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { withGoogleClient } from "./with-google";
import { getGoogleClient } from "./google-auth";
import { appendPending, type SendEmailAction } from "@/lib/confirm";
import { getRecentMedia } from "@/lib/memory/recent-media";
import { getMessageContent } from "@/lib/line/client";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export function buildEmailTools(userId: string) {
  return {
    draft_email: tool({
      description:
        "Draft an email to send from one of the user's connected Gmail accounts. Does NOT send — appends to the pending confirm queue. Pass arrays for to/cc/bcc. Attach Drive files via `attachments: [{fileId}]`. Attach a file the user just sent in LINE (image, video, audio, or document) via `attach_recent_media: true`.",
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
            "Set true to attach whatever the user most recently sent in LINE (image / video / audio / document). The system kept it for ~30 min after they sent it.",
          ),
        attach_recent_media_filename: z
          .string()
          .max(120)
          .optional()
          .describe(
            "Filename override for the staged LINE media. Defaults to its original name (or image.jpg / video.mp4 / etc).",
          ),
      }),
      execute: async ({
        to, cc, bcc, subject, body, fromEmail, attachments,
        attach_recent_media, attach_recent_media_filename,
      }) => {
        if (attach_recent_media) {
          const recent = await getRecentMedia(userId);
          if (!recent) {
            return {
              ok: false as const,
              error:
                "No recent LINE media is staged. Ask the user to (re)send the file in LINE; I keep each one for ~30 min.",
            };
          }
        }
        const action: SendEmailAction = {
          kind: "send_email",
          to,
          cc,
          bcc,
          subject,
          body,
          fromEmail,
          attachments,
          attachRecentMedia: attach_recent_media,
          attachRecentMediaFilename: attach_recent_media_filename,
        };
        await appendPending(userId, action);
        return {
          status: "draft_pending_confirmation" as const,
          draft: { to, cc, bcc, subject, body, fromEmail, attachments, attach_recent_media },
          instruction:
            "The system shows the verbatim draft to the user. Don't paraphrase the body.",
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
  if (args.attachRecentMedia) {
    const recent = await getRecentMedia(userId);
    if (!recent) {
      throw new Error(
        "Recent LINE media expired before send. Ask the user to resend the file and retry.",
      );
    }
    const { bytes, contentType } = await getMessageContent(recent.messageId);
    const filename =
      args.attachRecentMediaFilename ??
      recent.fileName ??
      defaultFilename(recent.kind, contentType);
    fetched.push({ filename, mimeType: contentType, bytes });
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
      "application/vnd.google-apps.document": {
        mime: "application/pdf",
        ext: ".pdf",
      },
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
  if (ext) return `${kind}${ext}`;
  return kind;
}
function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  // images
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
  if (m === "image/png") return ".png";
  if (m === "image/gif") return ".gif";
  if (m === "image/webp") return ".webp";
  if (m === "image/heic") return ".heic";
  // video
  if (m === "video/mp4") return ".mp4";
  if (m === "video/quicktime") return ".mov";
  if (m === "video/webm") return ".webm";
  // audio
  if (m === "audio/m4a" || m === "audio/x-m4a" || m === "audio/mp4") return ".m4a";
  if (m === "audio/mpeg" || m === "audio/mp3") return ".mp3";
  if (m === "audio/wav" || m === "audio/x-wav") return ".wav";
  if (m === "audio/ogg") return ".ogg";
  // docs
  if (m === "application/pdf") return ".pdf";
  if (m === "application/zip") return ".zip";
  return "";
}
