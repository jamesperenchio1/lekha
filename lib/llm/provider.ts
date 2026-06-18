import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
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

function groqClient() {
  const e = env();
  if (!e.GROQ_API_KEY) return null;
  return createGroq({ apiKey: e.GROQ_API_KEY });
}

// Back-compat alias used by extractorModel.
export function chatModel() {
  return chatModelForTier(hasFreeKey() ? "free" : "paid");
}

/**
 * Returns ordered list of Groq fallback models to try in sequence.
 * If one is unavailable / hits a per-model rate limit, the cascade walks on.
 * NOTE: text-only — no multimodal. Caller must skip on image/audio/video turns.
 *
 * Order picked for current Groq free-tier headroom + tool-use reliability:
 *   1. llama-4-maverick: 60K TPM (8× more than gpt-oss-120b), strong tool use
 *   2. llama-4-scout:    30K TPM, smaller/faster
 *   3. gpt-oss-120b:     8K TPM but very reliable when it fits
 */
export function fallbackChatModels() {
  const g = groqClient();
  if (!g) return [];
  return [
    // llama-4-scout: 30K TPM, completes multi-step tool calls reliably in 1-2s.
    // Primary fallback — high TPM headroom means it handles full conversations.
    g("meta-llama/llama-4-scout-17b-16e-instruct"),
    // gpt-oss-120b: 8K TPM ceiling — can handle single-step queries but hits
    // the limit on second step if there's been recent usage. Last resort.
    g("openai/gpt-oss-120b"),
  ];
}

/** Back-compat: first available Groq model. */
export function fallbackChatModel() {
  return fallbackChatModels()[0] ?? null;
}

/** Cheap model for background fact extraction + chunk summarization. */
export function extractorModel() {
  return googleClient()("gemini-flash-lite-latest");
}
