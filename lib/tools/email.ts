import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { getGoogleClient } from "./google-auth";
import { setPending, type SendEmailAction } from "@/lib/confirm";

export function buildEmailTools(userId: string) {
  return {
    draft_email: tool({
      description:
        "Draft an email to send from one of the user's connected Gmail accounts. Does NOT send — stores a draft and the user must reply YES. Pass an array for `to` to send the same message to multiple recipients (one tool call, not multiple). The system will render the verbatim draft to the user; do not paraphrase it in your reply.",
      inputSchema: z.object({
        to: z
          .array(z.string().email())
          .min(1)
          .max(20)
          .describe("Recipients. Pass all addresses in one call, not separate calls."),
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(10_000),
        fromEmail: z
          .string()
          .email()
          .optional()
          .describe(
            "Which of the user's connected Gmail accounts to send from. Omit to use the active account.",
          ),
      }),
      execute: async ({ to, subject, body, fromEmail }) => {
        const action: SendEmailAction = { kind: "send_email", to, subject, body, fromEmail };
        await setPending(userId, action);
        return {
          status: "draft_pending_confirmation" as const,
          draft: { to, subject, body, fromEmail },
          instruction: "The system will show the user the verbatim draft and ask for YES.",
        };
      },
    }),
  };
}

/** Actually send a previously-confirmed email. */
export async function sendEmail(
  userId: string,
  args: { to: string[]; subject: string; body: string; fromEmail?: string },
): Promise<{ from: string }> {
  const { client, email: from } = await getGoogleClient(userId, args.fromEmail);
  const gmail = google.gmail({ version: "v1", auth: client });
  // Single MIME message with multiple To: addresses.
  const raw = buildRawMime({ to: args.to, subject: args.subject, body: args.body, from });
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return { from };
}

function buildRawMime({
  to,
  subject,
  body,
  from,
}: {
  to: string[];
  subject: string;
  body: string;
  from: string;
}): string {
  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
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
