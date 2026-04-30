import { Redis } from "@upstash/redis";
import { redisCreds } from "@/lib/env";

let client: Redis | undefined;

export function redis(): Redis {
  if (!client) {
    const { url, token } = redisCreds();
    client = new Redis({ url, token });
  }
  return client;
}
