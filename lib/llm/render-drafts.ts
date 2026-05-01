/**
 * Inspect AI SDK tool calls from a generateText result and, if any drafts
 * (email or calendar) were produced, build canonical verbatim text the user
 * can review. This avoids the model paraphrasing/dropping detail.
 */

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
        subject?: string;
        body?: string;
        fromEmail?: string;
      };
      const to = (args.to ?? []).join(", ") || "(missing)";
      const from = args.fromEmail ?? fromEmailFallback ?? "(active account)";
      parts.push(
        [
          "📧 Draft email",
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${args.subject ?? "(missing)"}`,
          "",
          (args.body ?? "(missing)").trim(),
        ].join("\n"),
      );
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
  return `${parts.join("\n\n———\n\n")}\n\nReply YES to send/create, or describe edits.`;
}

function fmtRange(start?: string, end?: string): string {
  try {
    const s = start ? new Date(start).toLocaleString() : "?";
    const e = end ? new Date(end).toLocaleString() : "?";
    return `${s} → ${e}`;
  } catch {
    return `${start ?? "?"} → ${end ?? "?"}`;
  }
}
