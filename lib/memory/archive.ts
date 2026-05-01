import { redis } from "./redis";

export type ArchivedSummary = {
  id: string;
  /** Inclusive UNIX-ms range covered by this summary chunk. */
  fromTs: number;
  toTs: number;
  /** Compact LLM-generated summary of the conversation in that window. */
  summary: string;
  createdAt: number;
};

const key = (userId: string) => `user:${userId}:archive`;
const MAX = 200; // ~200 chunks ≈ years of conversation at our cadence

export async function appendArchive(
  userId: string,
  entry: Omit<ArchivedSummary, "id" | "createdAt">,
): Promise<void> {
  const e: ArchivedSummary = { id: crypto.randomUUID(), createdAt: Date.now(), ...entry };
  const k = key(userId);
  const tx = redis().multi();
  tx.rpush(k, JSON.stringify(e));
  tx.ltrim(k, -MAX, -1);
  await tx.exec();
}

export async function listArchive(userId: string): Promise<ArchivedSummary[]> {
  const raw = await redis().lrange<string | ArchivedSummary>(key(userId), 0, -1);
  return raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as ArchivedSummary) : r));
}

export async function searchArchive(userId: string, query: string): Promise<ArchivedSummary[]> {
  const all = await listArchive(userId);
  const q = query.toLowerCase();
  // Simple substring match — good enough until we need vector search.
  return all.filter((a) => a.summary.toLowerCase().includes(q));
}
