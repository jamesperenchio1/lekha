import { GoogleAuthRequired } from "@/lib/errors";
import { buildConnectUrl } from "@/lib/tools/google-auth";
import { sendEmail } from "@/lib/tools/email";
import { createCalendarEvent } from "@/lib/tools/calendar";
import type { PendingAction } from "@/lib/confirm";

/** Execute a queue of previously-confirmed pending actions in order. Returns user-facing reply. */
export async function executePendingAll(
  userId: string,
  actions: PendingAction[],
): Promise<string> {
  if (!actions.length) return "Nothing to confirm.";
  const lines: string[] = [];
  for (const action of actions) {
    lines.push(await executeOne(userId, action));
  }
  return lines.join("\n");
}

async function executeOne(userId: string, action: PendingAction): Promise<string> {
  if (action.kind === "send_email") {
    try {
      const r = await sendEmail(userId, action);
      const recipients = [
        ...action.to,
        ...(action.cc ?? []).map((c) => `cc:${c}`),
        ...(action.bcc ?? []).map((b) => `bcc:${b}`),
      ].join(", ");
      const att = action.attachments?.length
        ? ` with ${action.attachments.length} attachment(s)`
        : "";
      return `✅ Sent to ${recipients} (from ${r.from})${att}.`;
    } catch (err) {
      if (unwrapAuthRequired(err)) {
        return `I need Google access first. Connect here:\n${buildConnectUrl(userId)}`;
      }
      console.error("[send] failed", err);
      return `I couldn't send the email: ${errMsg(err)}`;
    }
  }
  if (action.kind === "create_calendar_event") {
    try {
      const r = await createCalendarEvent(userId, action);
      const intro = `✅ Added to ${r.from}'s calendar.`;
      const hint = `(open the link below while signed into Google as ${r.from} — otherwise Google will say "event not found")`;
      return r.htmlLink ? `${intro}\n${hint}\n${r.htmlLink}` : intro;
    } catch (err) {
      if (unwrapAuthRequired(err)) {
        return `I need Google access first. Connect here:\n${buildConnectUrl(userId)}`;
      }
      console.error("[calendar] failed", err);
      return `I couldn't create the event: ${errMsg(err)}`;
    }
  }
  return "Done.";
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 300);
  return String(err).slice(0, 300);
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
