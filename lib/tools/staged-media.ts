import { z } from "zod";
import { tool } from "ai";
import { listRecentMedia, clearRecentMedia } from "@/lib/memory/recent-media";

export function buildStagedMediaTools(userId: string) {
  return {
    list_staged_media: tool({
      description:
        "List the LINE files (images/videos/audio/documents) currently staged for attachment. Each one is 1-indexed in send order.",
      inputSchema: z.object({}),
      execute: async () => {
        const items = await listRecentMedia(userId);
        return {
          staged: items.map((m, i) => ({
            index: i + 1,
            kind: m.kind,
            fileName: m.fileName ?? null,
            mime: m.contentType,
            sizeKB: m.sizeBytes ? Math.round(m.sizeBytes / 1024) : null,
            durationSec: m.durationMs ? Math.round(m.durationMs / 1000) : null,
            sentSecondsAgo: Math.round((Date.now() - m.ts) / 1000),
          })),
        };
      },
    }),

    clear_staged_media: tool({
      description:
        "Discard all currently-staged LINE media. Use when the user says 'forget those files' or wants a clean slate before staging new ones.",
      inputSchema: z.object({}),
      execute: async () => {
        const before = await listRecentMedia(userId);
        await clearRecentMedia(userId);
        return { ok: true, cleared: before.length };
      },
    }),
  };
}
