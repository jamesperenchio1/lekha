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
        // Yahoo's /v7/quote endpoint started returning 401 to server-side calls
        // (it now needs a "crumb" cookie). The /v8/chart endpoint is still wide open.
        const symbol = ticker.toUpperCase();
        const t0 = Date.now();
        try {
          const data = await fetchJSON<{
            chart?: {
              result?: Array<{
                meta?: {
                  symbol?: string;
                  regularMarketPrice?: number;
                  previousClose?: number;
                  chartPreviousClose?: number;
                  currency?: string;
                  exchangeName?: string;
                  marketState?: string;
                  regularMarketTime?: number;
                };
              }>;
              error?: { code?: string; description?: string } | null;
            };
          }>(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
            { headers: { "user-agent": "Mozilla/5.0 lekha-bot/1.0" } },
          );
          console.log("[stock_price]", { ticker: symbol, ms: Date.now() - t0 });
          if (data.chart?.error) {
            return { ok: false, error: `Yahoo: ${data.chart.error.description ?? data.chart.error.code}` };
          }
          const meta = data.chart?.result?.[0]?.meta;
          if (!meta || meta.regularMarketPrice == null) {
            return { ok: false, error: `No price found for ticker "${symbol}". Check the symbol spelling.` };
          }
          const prev = meta.previousClose ?? meta.chartPreviousClose ?? null;
          const change = prev != null ? meta.regularMarketPrice - prev : null;
          const changePct = prev != null && prev !== 0 ? (change! / prev) * 100 : null;
          return {
            ok: true,
            symbol: meta.symbol,
            price: meta.regularMarketPrice,
            previousClose: prev,
            change,
            changePercent: changePct,
            currency: meta.currency ?? "USD",
            exchange: meta.exchangeName ?? null,
            marketState: meta.marketState,
            asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
          };
        } catch (err) {
          return {
            ok: false,
            error: `Stock lookup failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),

    stock_history: tool({
      description:
        "Get historical price movement for a stock ticker. Returns first / last / high / low / change% over the requested range. Use for questions like 'how has NVDA done this year', '1-year movement of STX', 'YTD performance'.",
      inputSchema: z.object({
        ticker: z.string().min(1).max(10),
        range: z.enum(["1mo", "3mo", "6mo", "1y", "2y", "5y", "ytd", "max"]).default("1y"),
      }),
      execute: async ({ ticker, range }) => {
        const symbol = ticker.toUpperCase();
        const t0 = Date.now();
        try {
          const data = await fetchJSON<{
            chart?: {
              result?: Array<{
                meta?: { currency?: string; symbol?: string };
                timestamp?: number[];
                indicators?: { quote?: Array<{ close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[] }> };
              }>;
              error?: { description?: string } | null;
            };
          }>(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
            { headers: { "user-agent": "Mozilla/5.0 lekha-bot/1.0" } },
          );
          console.log("[stock_history]", { ticker: symbol, range, ms: Date.now() - t0 });
          if (data.chart?.error) return { ok: false, error: `Yahoo: ${data.chart.error.description}` };
          const result = data.chart?.result?.[0];
          const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter((v): v is number => v != null);
          const highs = (result?.indicators?.quote?.[0]?.high ?? []).filter((v): v is number => v != null);
          const lows = (result?.indicators?.quote?.[0]?.low ?? []).filter((v): v is number => v != null);
          const ts = result?.timestamp ?? [];
          if (closes.length < 2 || ts.length < 2) {
            return { ok: false, error: `Not enough history for ${symbol}` };
          }
          const first = closes[0]!;
          const last = closes[closes.length - 1]!;
          const change = last - first;
          const changePct = (change / first) * 100;
          return {
            ok: true,
            symbol,
            range,
            currency: result?.meta?.currency ?? "USD",
            firstDate: new Date(ts[0]! * 1000).toISOString().slice(0, 10),
            lastDate: new Date(ts[ts.length - 1]! * 1000).toISOString().slice(0, 10),
            firstPrice: first,
            lastPrice: last,
            highPrice: Math.max(...highs),
            lowPrice: Math.min(...lows),
            change,
            changePercent: changePct,
            samples: closes.length,
          };
        } catch (err) {
          return { ok: false, error: `History lookup failed: ${err instanceof Error ? err.message : String(err)}` };
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
          // exchangerate.host now requires auth — use frankfurter.app (free, ECB-sourced)
          const data = await fetchJSON<{ rates?: Record<string, number> }>(
            `https://api.frankfurter.app/latest?from=${from.toUpperCase()}&to=${to.toUpperCase()}`,
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
