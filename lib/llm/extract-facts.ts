import { generateObject } from "ai";
import { z } from "zod";
import { extractorModel } from "./provider";
import { FACT_EXTRACTION_PROMPT } from "./prompts";
import { loadFacts, saveFacts, type UserFacts } from "@/lib/memory/facts";
import type { StoredTurn } from "@/lib/memory/history";

const Schema = z.object({
  facts: z.array(z.string()).max(15),
});

/**
 * Look at recent conversation, extract durable facts about the user, and merge
 * into the persisted facts blob (dedupe on lowercase exact match).
 */
export async function extractAndMergeFacts(userId: string, recent: StoredTurn[]): Promise<void> {
  if (recent.length < 4) return;

  const transcript = recent
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  const existing = await loadFacts(userId);
  const existingBlock = existing.bullets.length
    ? `\n\nFacts already known (do NOT repeat):\n${existing.bullets.map((b) => `- ${b}`).join("\n")}`
    : "";

  let result;
  try {
    result = await generateObject({
      model: extractorModel(),
      schema: Schema,
      system: FACT_EXTRACTION_PROMPT,
      prompt: `Conversation:\n${transcript}${existingBlock}`,
    });
  } catch (err) {
    console.warn("[facts] extraction failed", err);
    return;
  }

  const newFacts = result.object.facts
    .map((f) => f.trim())
    .filter((f) => f.length >= 5 && f.length <= 200);

  if (!newFacts.length) return;

  const lower = new Set(existing.bullets.map((b) => b.toLowerCase()));
  const merged: UserFacts = {
    bullets: [...existing.bullets],
    updatedAt: Date.now(),
  };
  for (const f of newFacts) {
    if (!lower.has(f.toLowerCase())) {
      merged.bullets.push(f);
      lower.add(f.toLowerCase());
    }
  }
  await saveFacts(userId, merged);
}
