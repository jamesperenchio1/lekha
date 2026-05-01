import { redis } from "@/lib/memory/redis";

const TTL_SEC = 5 * 60;

export type SendEmailAction = {
  kind: "send_email";
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  fromEmail?: string;
  /** Drive file IDs to attach. The bot fetches their bytes at send time. */
  attachments?: { fileId: string; fromEmail?: string }[];
};

export type CreateCalendarEventAction = {
  kind: "create_calendar_event";
  summary: string;
  startISO: string;
  endISO: string;
  description?: string;
  attendees?: string[];
  location?: string;
  fromEmail?: string;
};

export type PendingAction = SendEmailAction | CreateCalendarEventAction;

const key = (userId: string) => `pending:${userId}`;

/** Append an action to the pending queue (TTL 5 min). */
export async function appendPending(userId: string, action: PendingAction): Promise<void> {
  const existing = await getPending(userId);
  const next = [...existing, action];
  await redis().set(key(userId), next, { ex: TTL_SEC });
}

export async function getPending(userId: string): Promise<PendingAction[]> {
  const v = await redis().get<PendingAction[] | PendingAction>(key(userId));
  if (!v) return [];
  // Backward compat: previous schema stored a single object.
  return Array.isArray(v) ? v : [v];
}

export async function clearPending(userId: string): Promise<void> {
  await redis().del(key(userId));
}

const AFFIRMATIVE = new Set([
  "yes", "y", "yeah", "yep", "yup", "sure", "send", "send it", "send them", "do it",
  "go", "go ahead", "confirm", "confirmed", "ok", "okay", "k", "kk",
  "ครับ", "ค่ะ", "ใช่", "ส่ง", "ส่งเลย",
]);
const NEGATIVE = new Set([
  "no", "n", "nope", "cancel", "stop", "abort", "nvm", "nevermind", "never mind",
  "ไม่", "ยกเลิก",
]);

export type AffirmDecision = "yes" | "no" | "neither";
export function classify(text: string): AffirmDecision {
  const t = text.trim().toLowerCase();
  if (AFFIRMATIVE.has(t)) return "yes";
  if (NEGATIVE.has(t)) return "no";
  return "neither";
}
