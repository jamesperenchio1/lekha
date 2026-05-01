import { generateObject, generateText } from "ai";
import { z } from "zod";
import { extractorModel } from "./provider";
import { FACT_EXTRACTION_PROMPT } from "./prompts";
import { loadFacts, saveFacts, type UserFacts } from "@/lib/memory/facts";
import type { StoredTurn } from "@/lib/memory/history";
import { appendArchive } from "@/lib/memory/archive";

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

  if (newFacts.length) {
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

  // Also distill the chunk into a 2-3 sentence summary and append to long-term archive.
  // The rolling history is only 20 turns; archive lets the user retrieve old context months later.
  try {
    const r = await generateText({
      model: extractorModel(),
      system:
        "Summarize this conversation chunk between a user and their assistant in 2–4 sentences. Capture topics, decisions, commitments, and anything worth being able to recall in weeks. Be concrete (names, dates, places). Output the summary only.",
      prompt: transcript,
    });
    const summary = r.text.trim();
    if (summary.length > 30) {
      await appendArchive(userId, {
        fromTs: recent[0]?.ts ?? Date.now(),
        toTs: recent[recent.length - 1]?.ts ?? Date.now(),
        summary,
      });
    }
  } catch (err) {
    console.warn("[archive] summary failed", err);
  }
}
