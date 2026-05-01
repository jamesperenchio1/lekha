import { redis } from "./redis";

export type SentEntry = {
  id: string;
  ts: number;
  kind: "email" | "calendar_event" | "reminder_set";
  summary: string;
  detail?: Record<string, unknown>;
};

const key = (userId: string) => `user:${userId}:sent`;
const MAX = 200;

export async function logSent(userId: string, entry: Omit<SentEntry, "id" | "ts">): Promise<void> {
  const e: SentEntry = { id: crypto.randomUUID(), ts: Date.now(), ...entry };
  const k = key(userId);
  const tx = redis().multi();
  tx.lpush(k, JSON.stringify(e));
  tx.ltrim(k, 0, MAX - 1);
  // 6-month retention
  tx.expire(k, 60 * 60 * 24 * 180);
  await tx.exec();
}

export async function listSent(
  userId: string,
  filter?: { kind?: SentEntry["kind"]; sinceTs?: number; limit?: number },
): Promise<SentEntry[]> {
  const raw = await redis().lrange<string | SentEntry>(key(userId), 0, (filter?.limit ?? 50) - 1);
  let items = raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as SentEntry) : r));
  if (filter?.kind) items = items.filter((e) => e.kind === filter.kind);
  if (filter?.sinceTs) items = items.filter((e) => e.ts >= filter.sinceTs!);
  return items;
}
