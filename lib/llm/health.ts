import { redis } from "@/lib/memory/redis";

const tierKey = (tier: "free" | "paid") => `llm:gemini:${tier}:down_until`;

export async function markTierDown(tier: "free" | "paid", forSec = 60): Promise<void> {
  const until = Date.now() + forSec * 1000;
  await redis().set(tierKey(tier), until, { ex: forSec });
}

export async function isTierDown(tier: "free" | "paid"): Promise<boolean> {
  const until = await redis().get<number>(tierKey(tier));
  if (!until) return false;
  return Date.now() < until;
}

// Back-compat shims
export async function markGeminiDown(forSec = 60): Promise<void> {
  return markTierDown("paid", forSec);
}
export async function isGeminiDown(): Promise<boolean> {
  return isTierDown("paid");
}
