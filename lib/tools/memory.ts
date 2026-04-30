import { z } from "zod";
import { tool } from "ai";
import { appendFact, loadFacts } from "@/lib/memory/facts";

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
      description: "List the durable facts you currently remember about the user.",
      inputSchema: z.object({}),
      execute: async () => {
        const f = await loadFacts(userId);
        return { facts: f.bullets };
      },
    }),
  };
}
