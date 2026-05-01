import { redis } from "./redis";

const REGISTRY_KEY = "users:active";

/**
 * Track every LINE userId we've seen at least once. Needed by the cron sweep
 * (proactive layer) to enumerate users without scanning every Redis key.
 */
export async function registerUser(userId: string): Promise<void> {
  await redis().sadd(REGISTRY_KEY, userId);
}

export async function listAllUsers(): Promise<string[]> {
  return await redis().smembers(REGISTRY_KEY);
}

export async function unregisterUser(userId: string): Promise<void> {
  await redis().srem(REGISTRY_KEY, userId);
}
