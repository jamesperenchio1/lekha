import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { env } from "@/lib/env";

/**
 * Returns the chat model handle. Today: Gemini 2.5 Flash (free tier).
 * Tomorrow: swap to AI Gateway (`'google/gemini-2.5-flash'` string) or another
 * provider — only this file changes.
 */
function googleClient() {
  const e = env();
  const apiKey = e.GEMINI_API_KEY ?? e.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (or AI_GATEWAY_API_KEY) for LLM provider");
  }
  return createGoogleGenerativeAI({ apiKey });
}

/** Main chat model. Uses the `-latest` alias so we ride whatever flash variant
 * Google currently has the highest free-tier RPM allowance for. */
export function chatModel() {
  return googleClient()("gemini-flash-latest");
}

/** Cheaper/faster model for background fact extraction. */
export function extractorModel() {
  return googleClient()("gemini-flash-lite-latest");
}
