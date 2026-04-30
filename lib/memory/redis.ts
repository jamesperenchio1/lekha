import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";

let client: Redis | undefined;

export function redis(): Redis {
  if (!client) {
    client = new Redis({
      url: env().UPSTASH_REDIS_REST_URL,
      token: env().UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return client;
}
