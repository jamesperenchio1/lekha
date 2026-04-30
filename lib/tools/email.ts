import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { getGoogleClient } from "./google-auth";
import { setPending, type PendingAction } from "@/lib/confirm";

export function buildEmailTools(userId: string) {
  return {
    draft_email: tool({
      description:
        "Draft an email to send from the user's own Gmail account. This does NOT send the email yet — it stores a draft and the user must reply YES to send. After calling this, your reply should restate the draft and ask for confirmation.",
      inputSchema: z.object({
        to: z.string().email(),
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(10_000),
      }),
      execute: async ({ to, subject, body }) => {
        const action: PendingAction = { kind: "send_email", to, subject, body };
        await setPending(userId, action);
        return {
          status: "draft_pending_confirmation" as const,
          draft: { to, subject, body },
          instruction:
            "Show the user the draft and ask them to reply YES to send (or describe edits).",
        };
      },
    }),
  };
}

/** Actually send a previously-confirmed email. Called by the orchestrator. */
export async function sendEmail(
  userId: string,
  args: { to: string; subject: string; body: string },
): Promise<void> {
  const auth = await getGoogleClient(userId);
  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildRawMime(args);
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
}

function buildRawMime({ to, subject, body }: { to: string; subject: string; body: string }): string {
  const headers = [
    `To: ${to}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    `Subject: ${encodeHeader(subject)}`,
  ].join("\r\n");
  const message = `${headers}\r\n\r\n${body}`;
  return Buffer.from(message, "utf8").toString("base64url");
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}
