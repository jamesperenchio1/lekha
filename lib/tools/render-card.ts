import { z } from "zod";
import { tool } from "ai";

export function buildRenderCardTool() {
  return {
    render_card: tool({
      description:
        "Display a rich visual card for data you just retrieved. Call this in the SAME step as the data tool — the card is built automatically from that tool's result. When you call render_card, your text reply should be a brief 1-sentence intro only (e.g. 'Here's Bangkok right now 🌤️' or 'Bitcoin today 🪙').",
      inputSchema: z.object({
        type: z
          .enum(["weather", "stock", "crypto"])
          .describe("weather → pairs with weather tool · stock → pairs with stock_price · crypto → pairs with crypto_price"),
      }),
      execute: async ({ type }) => ({ ok: true, type }),
    }),
  };
}
