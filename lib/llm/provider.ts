import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { env } from "@/lib/env";

function googleClient() {
  const e = env();
  const apiKey = e.GEMINI_API_KEY ?? e.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (or AI_GATEWAY_API_KEY) for LLM provider");
  }
  return createGoogleGenerativeAI({ apiKey });
}

function groqClient() {
  const e = env();
  if (!e.GROQ_API_KEY) return null;
  return createGroq({ apiKey: e.GROQ_API_KEY });
}

/**
 * Main chat model. Default `gemini-flash-lite-latest` because it currently
 * has the best free-tier RPD allowance (500/day vs 20 for full Flash) while
 * still being smart enough for tool routing in this agent.
 */
export function chatModel() {
  return googleClient()("gemini-flash-lite-latest");
}

/**
 * Optional fallback used when Gemini returns a quota / rate-limit error.
 * Llama 3.3 70B on Groq is solid at tool use, free tier is ~30 RPM.
 * NOTE: text-only — no multimodal. Caller must skip on image/audio/video turns.
 * Returns null when no Groq key is configured.
 */
export function fallbackChatModel() {
  const g = groqClient();
  return g ? g("llama-3.3-70b-versatile") : null;
}

/** Cheap model for background fact extraction + chunk summarization. */
export function extractorModel() {
  return googleClient()("gemini-flash-lite-latest");
}
