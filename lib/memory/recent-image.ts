import { redis } from "./redis";

const TTL_SEC = 30 * 60;

export type RecentImage = {
  messageId: string;
  contentType: string;
  sizeBytes: number;
  ts: number;
};

const key = (userId: string) => `recent_image:${userId}`;

export async function setRecentImage(userId: string, img: RecentImage): Promise<void> {
  await redis().set(key(userId), img, { ex: TTL_SEC });
}

export async function getRecentImage(userId: string): Promise<RecentImage | null> {
  return (await redis().get<RecentImage>(key(userId))) ?? null;
}

export async function clearRecentImage(userId: string): Promise<void> {
  await redis().del(key(userId));
}
