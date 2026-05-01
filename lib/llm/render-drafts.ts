/**
 * Inspect AI SDK tool calls from a generateText result and, if any drafts
 * (email or calendar) were produced, build canonical verbatim text the user
 * can review. Avoids the model paraphrasing/dropping detail.
 */

const DISPLAY_TZ = "Asia/Bangkok";

type ToolCall = {
  toolName: string;
  input?: unknown;
};

export function renderDraftsBlock(
  toolCalls: ReadonlyArray<ToolCall>,
  fromEmailFallback: string | null,
): string | null {
  const parts: string[] = [];
  for (const call of toolCalls) {
    if (call.toolName === "draft_email") {
      const args = call.input as {
        to?: string[];
        cc?: string[];
        bcc?: string[];
        subject?: string;
        body?: string;
        fromEmail?: string;
        attachments?: { fileId: string }[];
        attach_recent_image?: boolean;
      };
      const lines = [
        "📧 Draft email",
        `From: ${args.fromEmail ?? fromEmailFallback ?? "(active account)"}`,
        `To: ${(args.to ?? []).join(", ") || "(missing)"}`,
      ];
      if (args.cc?.length) lines.push(`Cc: ${args.cc.join(", ")}`);
      if (args.bcc?.length) lines.push(`Bcc: ${args.bcc.join(", ")}`);
      lines.push(`Subject: ${args.subject ?? "(missing)"}`);
      const attBits: string[] = [];
      if (args.attachments?.length) {
        attBits.push(
          `${args.attachments.length} from Drive (ids: ${args.attachments.map((a) => a.fileId).join(", ")})`,
        );
      }
      if (args.attach_recent_image) attBits.push("the most recent image you sent");
      if (attBits.length) lines.push(`Attachments: ${attBits.join("; ")}`);
      lines.push("", (args.body ?? "(missing)").trim());
      parts.push(lines.join("\n"));
    } else if (call.toolName === "draft_calendar_event") {
      const args = call.input as {
        summary?: string;
        startISO?: string;
        endISO?: string;
        location?: string;
        attendees?: string[];
        description?: string;
        fromEmail?: string;
      };
      const lines = [
        "📅 Draft calendar event",
        `Calendar: ${args.fromEmail ?? fromEmailFallback ?? "(active account)"}`,
        `Title: ${args.summary ?? "(missing)"}`,
        `When: ${fmtRange(args.startISO, args.endISO)}`,
      ];
      if (args.location) lines.push(`Where: ${args.location}`);
      if (args.attendees?.length) lines.push(`Attendees: ${args.attendees.join(", ")}`);
      if (args.description) lines.push("", args.description.trim());
      parts.push(lines.join("\n"));
    }
  }
  if (!parts.length) return null;
  return `${parts.join("\n\n———\n\n")}\n\nReply YES to send/create all of the above (or describe edits).`;
}

function fmtRange(start?: string, end?: string): string {
  try {
    const s = start ? fmtDate(start) : "?";
    const e = end ? fmtDate(end) : "?";
    return `${s} → ${e} (Bangkok)`;
  } catch {
    return `${start ?? "?"} → ${end ?? "?"}`;
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: DISPLAY_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
