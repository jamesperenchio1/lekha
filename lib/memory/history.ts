import { redis } from "./redis";

const MAX_TURNS = 20;

export type StoredTurn = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

const key = (userId: string) => `user:${userId}:history`;

export async function loadHistory(userId: string): Promise<StoredTurn[]> {
  // LRANGE returns newest-first because we LPUSH; reverse to chronological.
  const raw = await redis().lrange<StoredTurn | string>(key(userId), 0, MAX_TURNS - 1);
  const parsed = raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as StoredTurn) : r));
  return parsed.reverse();
}

export async function appendTurn(userId: string, turn: StoredTurn): Promise<number> {
  const k = key(userId);
  const tx = redis().multi();
  tx.lpush(k, turn);
  tx.ltrim(k, 0, MAX_TURNS - 1);
  tx.llen(k);
  const res = (await tx.exec()) as [number, string, number];
  return res[2];
}

/** Total messages we've seen for this user (for fact-extraction cadence). */
export async function turnCounter(userId: string): Promise<number> {
  return (await redis().incr(`user:${userId}:turn_counter`)) as number;
}
