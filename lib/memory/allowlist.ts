import { redis } from "./redis";

const KEY = "users:allowed";

export async function isAllowed(userId: string): Promise<boolean> {
  return (await redis().sismember(KEY, userId)) === 1;
}
export async function addToAllowlist(userId: string): Promise<void> {
  await redis().sadd(KEY, userId);
}
export async function removeFromAllowlist(userId: string): Promise<void> {
  await redis().srem(KEY, userId);
}
export async function listAllowed(): Promise<string[]> {
  return redis().smembers(KEY);
}
