import { z } from "zod";
import { tool } from "ai";

/**
 * Fast, no-auth realtime data tools. Each has a hard ~3s AbortController.
 * Prefer these over web_search whenever the model can — single-digit-ms
 * round-trips vs Tavily's 5-8s for the same answer.
 */

const TIMEOUT_MS = 3000;

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export function buildFinanceTools() {
  return {
    stock_price: tool({
      description:
        "Get the current price + day change for a stock ticker. Fast (<1s). Use this for ANY stock-price question — never web_search for stock prices.",
      inputSchema: z.object({
        ticker: z.string().min(1).max(10).describe("Ticker symbol like NVDA, AAPL, TSLA, GOOG"),
      }),
      execute: async ({ ticker }) => {
        try {
          // Yahoo Finance public quote endpoint — no auth required.
          const t0 = Date.now();
          const data = await fetchJSON<{
            quoteResponse?: { result?: Array<{
              symbol?: string;
              shortName?: string;
              regularMarketPrice?: number;
              regularMarketChange?: number;
              regularMarketChangePercent?: number;
              currency?: string;
              marketState?: string;
              regularMarketTime?: number;
            }> };
          }>(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker.toUpperCase())}`,
             { headers: { "user-agent": "Mozilla/5.0 lekha-bot" } });
          console.log("[stock_price]", { ticker, ms: Date.now() - t0 });
          const q = data.quoteResponse?.result?.[0];
          if (!q || q.regularMarketPrice == null) {
            return { ok: false, error: `No data for ${ticker}` };
          }
          return {
            ok: true,
            symbol: q.symbol,
            name: q.shortName,
            price: q.regularMarketPrice,
            change: q.regularMarketChange,
            changePercent: q.regularMarketChangePercent,
            currency: q.currency ?? "USD",
            marketState: q.marketState,
            asOf: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Lookup failed" };
        }
      },
    }),

    crypto_price: tool({
      description:
        "Get the current USD price + 24h change for a cryptocurrency by CoinGecko id (bitcoin, ethereum, solana, etc.) or common ticker (btc, eth, sol). Fast (<1s). Use this for ANY crypto-price question.",
      inputSchema: z.object({
        coin: z.string().min(1).max(40),
      }),
      execute: async ({ coin }) => {
        const norm = coin.toLowerCase().trim();
        const aliases: Record<string, string> = {
          btc: "bitcoin", eth: "ethereum", sol: "solana", doge: "dogecoin",
          ada: "cardano", xrp: "ripple", bnb: "binancecoin", trx: "tron",
          ltc: "litecoin", dot: "polkadot", link: "chainlink", matic: "matic-network",
          avax: "avalanche-2", uni: "uniswap", atom: "cosmos", near: "near",
          shib: "shiba-inu", pepe: "pepe", wif: "dogwifcoin",
        };
        const id = aliases[norm] ?? norm;
        try {
          const t0 = Date.now();
          const data = await fetchJSON<Record<string, {
            usd?: number;
            usd_24h_change?: number;
            last_updated_at?: number;
          }>>(
            `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`,
          );
          console.log("[crypto_price]", { coin: id, ms: Date.now() - t0 });
          const q = data[id];
          if (!q || q.usd == null) {
            return { ok: false, error: `No data for "${coin}" (tried CoinGecko id "${id}"). Try a different name.` };
          }
          return {
            ok: true,
            id,
            usd: q.usd,
            change24h: q.usd_24h_change ?? null,
            asOf: q.last_updated_at ? new Date(q.last_updated_at * 1000).toISOString() : null,
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Lookup failed" };
        }
      },
    }),

    fx_rate: tool({
      description:
        "Convert between currencies using live exchange rates (1s). Use this for FX questions — never web_search.",
      inputSchema: z.object({
        from: z.string().length(3).describe("3-letter currency code, e.g. USD"),
        to: z.string().length(3).describe("3-letter currency code, e.g. THB"),
        amount: z.number().positive().default(1),
      }),
      execute: async ({ from, to, amount }) => {
        try {
          const t0 = Date.now();
          const data = await fetchJSON<{ rates?: Record<string, number>; base?: string }>(
            `https://api.exchangerate.host/latest?base=${from.toUpperCase()}&symbols=${to.toUpperCase()}`,
          );
          console.log("[fx_rate]", { from, to, ms: Date.now() - t0 });
          const rate = data.rates?.[to.toUpperCase()];
          if (!rate) return { ok: false, error: `No rate for ${from}→${to}` };
          return {
            ok: true,
            from: from.toUpperCase(),
            to: to.toUpperCase(),
            rate,
            amount,
            converted: rate * amount,
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Lookup failed" };
        }
      },
    }),
  };
}
