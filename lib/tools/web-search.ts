import { z } from "zod";
import { tool } from "ai";
import { env } from "@/lib/env";

type TavilyResult = {
  title: string;
  url: string;
  content: string;
};

type TavilyResponse = {
  answer?: string;
  results?: TavilyResult[];
};

export function buildWebSearchTool() {
  return {
    web_search: tool({
      description:
        "Search the web for fresh, factual information. Use for news, current events, prices, schedules, or anything that may have changed recently. Do NOT use for general knowledge you already have.",
      inputSchema: z.object({
        query: z.string().min(2).max(200),
      }),
      execute: async ({ query }) => {
        const apiKey = env().TAVILY_API_KEY;
        if (!apiKey) return { ok: false, error: "Web search not configured" };
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 6000);
        const t0 = Date.now();
        try {
          const r = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: apiKey,
              query,
              max_results: 3,
              include_answer: true,
              search_depth: "basic",
            }),
            signal: ctrl.signal,
          });
          console.log("[web_search] tavily", { query, ms: Date.now() - t0, status: r.status });
          if (!r.ok) return { ok: false, error: `Search failed: ${r.status}` };
          const data = (await r.json()) as TavilyResponse;
          return {
            ok: true,
            answer: data.answer ?? null,
            results:
              data.results?.map((res) => ({
                title: res.title,
                url: res.url,
                snippet: res.content.slice(0, 400),
              })) ?? [],
          };
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") {
            console.warn("[web_search] timeout after 6s", { query });
            return { ok: false, error: "Search timed out after 6s — Tavily was slow or unreachable." };
          }
          return { ok: false, error: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
        } finally {
          clearTimeout(timeout);
        }
      },
    }),
  };
}
