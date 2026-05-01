import { redis } from "@/lib/memory/redis";

const GEMINI_DOWN_KEY = "llm:gemini:down_until";

/**
 * After Gemini returns a 503/quota error, mark it "down" for a short window
 * so subsequent requests skip straight to the Groq fallback. Avoids burning
 * 5-10s on a Gemini call we know will fail.
 */
export async function markGeminiDown(forSec = 60): Promise<void> {
  const until = Date.now() + forSec * 1000;
  await redis().set(GEMINI_DOWN_KEY, until, { ex: forSec });
}

/** Returns true if we marked Gemini as down within the cooldown window. */
export async function isGeminiDown(): Promise<boolean> {
  const until = await redis().get<number>(GEMINI_DOWN_KEY);
  if (!until) return false;
  return Date.now() < until;
}
