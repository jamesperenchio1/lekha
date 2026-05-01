import { z } from "zod";
import { tool } from "ai";
import { loadHistory } from "@/lib/memory/history";
import { loadFacts } from "@/lib/memory/facts";
import { listArchive } from "@/lib/memory/archive";
import { listTasks } from "@/lib/memory/tasks";
import { listSent } from "@/lib/memory/sent-log";
import { getSettings } from "@/lib/memory/settings";

export function buildExportTools(userId: string) {
  return {
    export_my_data: tool({
      description:
        "Dump everything Lekha stores about the user as a JSON snapshot — settings, facts, history, archived summaries, tasks, sent-action log. Use when the user asks to export, back up, or audit their data.",
      inputSchema: z.object({}),
      execute: async () => {
        const [settings, facts, history, archive, openTasks, allTasks, sent] = await Promise.all([
          getSettings(userId),
          loadFacts(userId),
          loadHistory(userId),
          listArchive(userId),
          listTasks(userId, "open"),
          listTasks(userId, "all"),
          listSent(userId, { limit: 200 }),
        ]);
        return {
          generatedAt: new Date().toISOString(),
          settings,
          memory: { facts: facts.bullets, archive },
          conversation: { recent: history },
          tasks: { open: openTasks, all: allTasks },
          sent,
          notes:
            "OAuth tokens and other secrets are intentionally excluded for security. Only your application data is shown.",
        };
      },
    }),
  };
}
