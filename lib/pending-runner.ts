import { GoogleAuthRequired } from "@/lib/errors";
import { buildConnectUrl } from "@/lib/tools/google-auth";
import { sendEmail } from "@/lib/tools/email";
import { createCalendarEvent } from "@/lib/tools/calendar";
import type { PendingAction } from "@/lib/confirm";

/** Execute a previously-confirmed pending action. Returns user-facing reply text. */
export async function executePending(userId: string, action: PendingAction): Promise<string> {
  if (action.kind === "send_email") {
    try {
      const r = await sendEmail(userId, action);
      return `✅ Sent to ${action.to.join(", ")} (from ${r.from}).`;
    } catch (err) {
      if (unwrapAuthRequired(err)) {
        return `I need Google access first. Connect here:\n${buildConnectUrl(userId)}`;
      }
      console.error("[send] failed", err);
      return "I couldn't send that. Want me to try again?";
    }
  }
  if (action.kind === "create_calendar_event") {
    try {
      const r = await createCalendarEvent(userId, action);
      const intro = `✅ Added to your ${r.from} calendar.`;
      return r.htmlLink ? `${intro}\n${r.htmlLink}` : intro;
    } catch (err) {
      if (unwrapAuthRequired(err)) {
        return `I need Google access first. Connect here:\n${buildConnectUrl(userId)}`;
      }
      console.error("[calendar] failed", err);
      return "I couldn't add that. Want me to try again?";
    }
  }
  return "Done.";
}

function unwrapAuthRequired(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof GoogleAuthRequired) return true;
    const next =
      (cur as { cause?: unknown; originalError?: unknown }).cause ??
      (cur as { originalError?: unknown }).originalError;
    if (!next) break;
    cur = next;
  }
  return false;
}
