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
 * If one is unavailable / deprecated, the cascade walks to the next.
 * NOTE: text-only — no multimodal. Caller must skip on image/audio/video turns.
 */
export function fallbackChatModels() {
  const g = groqClient();
  if (!g) return [];
  return [
    g("openai/gpt-oss-120b"),               // Groq's strongest tool-using model right now
    g("moonshotai/kimi-k2-instruct-0905"), // Kimi K2 — explicitly tuned for agents
    g("llama-3.3-70b-versatile"),          // Fallback to the proven workhorse
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
