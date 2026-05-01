import { redis } from "./redis";

const TTL_SEC = 30 * 60;
const MAX_ITEMS = 10;

export type MediaKind = "image" | "video" | "audio" | "file";

export type RecentMedia = {
  kind: MediaKind;
  messageId: string;
  contentType: string;
  /** Filename LINE provided (always for `file` messages, sometimes others). */
  fileName?: string;
  /** Byte size LINE provided (always for `file` messages). */
  sizeBytes?: number;
  /** Duration in ms (audio/video). */
  durationMs?: number;
  ts: number;
};

const key = (userId: string) => `recent_media:${userId}`;

/** Append a new staged media item. Atomic, capped at MAX_ITEMS, refreshes TTL. */
export async function appendRecentMedia(userId: string, m: RecentMedia): Promise<void> {
  const k = key(userId);
  const tx = redis().multi();
  tx.rpush(k, JSON.stringify(m));
  tx.ltrim(k, -MAX_ITEMS, -1);
  tx.expire(k, TTL_SEC);
  await tx.exec();
}

/** Return all staged media in the order the user sent them (oldest → newest). */
export async function listRecentMedia(userId: string): Promise<RecentMedia[]> {
  const raw = await redis().lrange<string | RecentMedia>(key(userId), 0, -1);
  return raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as RecentMedia) : r));
}

export async function clearRecentMedia(userId: string): Promise<void> {
  await redis().del(key(userId));
}
