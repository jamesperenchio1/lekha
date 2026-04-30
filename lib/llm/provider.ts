import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { env } from "@/lib/env";

/**
 * Returns the chat model handle. Today: Gemini 2.5 Flash (free tier).
 * Tomorrow: swap to AI Gateway (`'google/gemini-2.5-flash'` string) or another
 * provider — only this file changes.
 */
export function chatModel() {
  const e = env();
  const apiKey = e.GEMINI_API_KEY ?? e.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (or AI_GATEWAY_API_KEY) for LLM provider");
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google("gemini-2.5-flash");
}

/**
 * Cheaper/faster model for background tasks like fact extraction.
 */
export function extractorModel() {
  const e = env();
  const apiKey = e.GEMINI_API_KEY ?? e.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (or AI_GATEWAY_API_KEY) for LLM provider");
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google("gemini-2.5-flash-lite");
}
