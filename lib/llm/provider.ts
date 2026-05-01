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
