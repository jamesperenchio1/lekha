import { redis } from "@/lib/memory/redis";

const TTL_SEC = 5 * 60;

export type PendingAction =
  | {
      kind: "send_email";
      to: string;
      subject: string;
      body: string;
    }
  | {
      kind: "create_calendar_event";
      summary: string;
      startISO: string;
      endISO: string;
      description?: string;
      attendees?: string[];
      location?: string;
    };

const key = (userId: string) => `pending:${userId}`;

export async function setPending(userId: string, action: PendingAction): Promise<void> {
  await redis().set(key(userId), action, { ex: TTL_SEC });
}

export async function getPending(userId: string): Promise<PendingAction | null> {
  return (await redis().get<PendingAction>(key(userId))) ?? null;
}

export async function clearPending(userId: string): Promise<void> {
  await redis().del(key(userId));
}

const AFFIRMATIVE = new Set([
  "yes", "y", "yeah", "yep", "yup", "sure", "send", "send it", "do it",
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
