import { redis } from "./redis";

const TTL_SEC = 30 * 60;

export type MediaKind = "image" | "video" | "audio" | "file";

export type RecentMedia = {
  kind: MediaKind;
  messageId: string;
  contentType: string;
  /** LINE-provided filename (only set on `file` messages, sometimes others). */
  fileName?: string;
  /** LINE-provided byte size (set on `file` messages). */
  sizeBytes?: number;
  /** LINE-provided duration in ms (audio/video). */
  durationMs?: number;
  ts: number;
};

const key = (userId: string) => `recent_media:${userId}`;

export async function setRecentMedia(userId: string, m: RecentMedia): Promise<void> {
  await redis().set(key(userId), m, { ex: TTL_SEC });
}

export async function getRecentMedia(userId: string): Promise<RecentMedia | null> {
  return (await redis().get<RecentMedia>(key(userId))) ?? null;
}

export async function clearRecentMedia(userId: string): Promise<void> {
  await redis().del(key(userId));
}
