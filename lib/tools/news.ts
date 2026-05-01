import { z } from "zod";
import { tool } from "ai";
import { env } from "@/lib/env";

type TavilyNewsResult = {
  title: string;
  url: string;
  content: string;
  published_date?: string;
};

type TavilyNewsResponse = {
  answer?: string;
  results?: TavilyNewsResult[];
};

export function buildNewsTools() {
  return {
    news_search: tool({
      description:
        "Search recent news headlines for a topic. Returns top 5 stories with title, source URL, snippet, and published date. Use for questions like 'what's the latest news on X', 'any updates on Y', morning briefings.",
      inputSchema: z.object({
        query: z.string().min(2).max(200),
        days: z.number().int().min(1).max(30).default(2).describe("How many days back to look. Default 2."),
      }),
      execute: async ({ query, days }) => {
        const apiKey = env().TAVILY_API_KEY;
        if (!apiKey) return { ok: false, error: "News search not configured (Tavily key missing)" };
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const t0 = Date.now();
        try {
          const r = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: apiKey,
              query,
              max_results: 5,
              include_answer: true,
              search_depth: "basic",
              topic: "news",
              days,
            }),
            signal: ctrl.signal,
          });
          console.log("[news_search]", { query, ms: Date.now() - t0, status: r.status });
          if (!r.ok) return { ok: false, error: `News search failed: HTTP ${r.status}` };
          const data = (await r.json()) as TavilyNewsResponse;
          return {
            ok: true,
            summary: data.answer ?? null,
            stories:
              data.results?.map((s) => ({
                title: s.title,
                url: s.url,
                snippet: s.content.slice(0, 300),
                published: s.published_date ?? null,
              })) ?? [],
          };
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") {
            return { ok: false, error: "News search timed out after 6s." };
          }
          return { ok: false, error: `News search failed: ${err instanceof Error ? err.message : String(err)}` };
        } finally {
          clearTimeout(t);
        }
      },
    }),
  };
}
