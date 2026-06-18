import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { env } from "@/lib/env";

export function hasFreeKey(): boolean {
  return Boolean(env().GEMINI_API_KEY_FREE);
}

export function hasPaidKey(): boolean {
  const e = env();
  return Boolean(e.GEMINI_API_KEY ?? e.AI_GATEWAY_API_KEY);
}

export function chatModelForTier(tier: "free" | "paid") {
  const e = env();
  const apiKey = tier === "free"
    ? e.GEMINI_API_KEY_FREE
    : (e.GEMINI_API_KEY ?? e.AI_GATEWAY_API_KEY);
  if (!apiKey) throw new Error(`No ${tier} Gemini API key configured`);
  return createGoogleGenerativeAI({ apiKey })("gemini-flash-lite-latest");
}

export function chatModel() {
  return chatModelForTier(hasFreeKey() ? "free" : "paid");
}

/** Cheap model for background fact extraction + chunk summarization. */
export function extractorModel() {
  return chatModel();
}
