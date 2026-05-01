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
  attachments?: { fileId: string; fromEmail?: string }[];
  /** Attach ALL staged LINE media. Mutually exclusive with attachRecentMediaIndexes. */
  attachRecentMedia?: boolean;
  /** 1-indexed cherry-pick from staged LINE media (oldest is 1). */
  attachRecentMediaIndexes?: number[];
  /** Filename overrides aligned to the same order as the indexes (or all staged when attachRecentMedia is true). */
  attachRecentMediaFilenames?: string[];
  /** Reply-to-thread metadata for Gmail threading (when this is a reply). */
  inReplyToMessageIdHdr?: string;
  references?: string;
  threadId?: string;
  /** Optional QStash schedule id if this email is being sent later (scheduled). */
  scheduledForTs?: number;
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

/**
 * Append an action to the pending queue ATOMICALLY.
 * Uses RPUSH so concurrent tool calls in the same agent turn don't race
 * (which would make one of them silently overwrite the other).
 */
export async function appendPending(userId: string, action: PendingAction): Promise<void> {
  const k = key(userId);
  const tx = redis().multi();
  tx.rpush(k, JSON.stringify(action));
  tx.expire(k, TTL_SEC);
  await tx.exec();
}

export async function getPending(userId: string): Promise<PendingAction[]> {
  const raw = await redis().lrange<string | PendingAction>(key(userId), 0, -1);
  return raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as PendingAction) : r));
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
