import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "@/lib/memory/redis";

let limiter: Ratelimit | undefined;

function getLimiter(): Ratelimit {
  if (!limiter) {
    limiter = new Ratelimit({
      redis: redis(),
      // 30 messages per hour per user, sliding window.
      limiter: Ratelimit.slidingWindow(30, "1 h"),
      prefix: "ratelimit:user",
      analytics: false,
    });
  }
  return limiter;
}

export async function checkRateLimit(userId: string): Promise<{
  ok: boolean;
  retryAfterSec: number;
}> {
  const r = await getLimiter().limit(userId);
  const retryAfterSec = Math.max(0, Math.ceil((r.reset - Date.now()) / 1000));
  return { ok: r.success, retryAfterSec };
}
