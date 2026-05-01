import { z } from "zod";
import { tool } from "ai";
import {
  appendFact,
  loadFacts,
  updateFact,
  removeFact,
  clearFacts,
} from "@/lib/memory/facts";
import { searchArchive, listArchive } from "@/lib/memory/archive";

export function buildMemoryTools(userId: string) {
  return {
    remember: tool({
      description:
        "Save a durable fact about the user that you should recall in future conversations. Use when the user explicitly says 'remember that I…', or when they share something clearly worth retaining (preferences, important relationships, recurring events). Keep each fact short and self-contained.",
      inputSchema: z.object({
        fact: z.string().min(3).max(200),
      }),
      execute: async ({ fact }) => {
        await appendFact(userId, fact);
        return { ok: true };
      },
    }),

    list_memories: tool({
      description: "List the durable facts you currently remember about the user. 1-indexed.",
      inputSchema: z.object({}),
      execute: async () => {
        const f = await loadFacts(userId);
        return { facts: f.bullets.map((b, i) => ({ index: i + 1, text: b })) };
      },
    }),

    update_memory: tool({
      description: "Replace a stored fact at a 1-indexed position.",
      inputSchema: z.object({
        index: z.number().int().min(1),
        new_fact: z.string().min(3).max(200),
      }),
      execute: async ({ index, new_fact }) => {
        const ok = await updateFact(userId, index, new_fact);
        return ok ? { ok: true } : { ok: false, error: "Index out of range" };
      },
    }),

    forget_memory: tool({
      description: "Delete a stored fact at a 1-indexed position.",
      inputSchema: z.object({ index: z.number().int().min(1) }),
      execute: async ({ index }) => {
        const ok = await removeFact(userId, index);
        return ok ? { ok: true } : { ok: false, error: "Index out of range" };
      },
    }),

    clear_all_memories: tool({
      description:
        "Wipe all stored facts about the user. Destructive — only use when the user explicitly asks for a clean slate.",
      inputSchema: z.object({}),
      execute: async () => ({ cleared: await clearFacts(userId) }),
    }),

    search_archived_memory: tool({
      description:
        "Search older conversations beyond the rolling 20-message history. Returns archived chunk summaries. Use when the user references something from days/weeks ago.",
      inputSchema: z.object({ query: z.string().min(2).max(200) }),
      execute: async ({ query }) => {
        const hits = await searchArchive(userId, query);
        return { results: hits };
      },
    }),

    list_archived_memory: tool({
      description: "List all archived conversation summaries (chronological).",
      inputSchema: z.object({}),
      execute: async () => ({ chunks: await listArchive(userId) }),
    }),
  };
}
