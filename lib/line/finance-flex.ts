import { flex, type LineMessage } from "./client";

export type StockResult = {
  ok: true;
  symbol: string;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string;
  exchange: string | null;
  marketState: string | undefined;
  asOf: string | null;
  source: string;
};

export type CryptoResult = {
  ok: true;
  id: string;
  usd: number;
  change24h: number | null;
  asOf: string | null;
  source: string;
};

export function buildStockFlex(r: StockResult): LineMessage {
  const isUp = r.change != null ? r.change >= 0 : null;
  const changeColor = isUp === true ? "#4CAF50" : isUp === false ? "#F44336" : "#888888";
  const arrow = isUp === true ? "▲" : isUp === false ? "▼" : "—";

  const priceText = fmtPrice(r.price, r.currency);
  const changeText =
    r.change != null && r.changePercent != null
      ? `${arrow} ${r.change >= 0 ? "+" : ""}${fmtPrice(Math.abs(r.change), r.currency)} (${r.changePercent >= 0 ? "+" : ""}${r.changePercent.toFixed(2)}%)`
      : r.changePercent != null
        ? `${arrow} ${r.changePercent >= 0 ? "+" : ""}${r.changePercent.toFixed(2)}%`
        : "—";

  const bodyRows: unknown[] = [];
  if (r.previousClose != null) bodyRows.push(makeRow("Prev close", fmtPrice(r.previousClose, r.currency)));
  if (r.exchange) {
    bodyRows.push({ type: "separator", color: "#eeeeee" });
    bodyRows.push(makeRow("Exchange", r.exchange));
  }
  bodyRows.push({ type: "separator", color: "#eeeeee" });
  bodyRows.push(makeRow("Market", marketLabel(r.marketState)));

  const bubble: Record<string, unknown> = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#1A237E",
      paddingAll: "20px",
      contents: [
        { type: "text", text: `📊 ${r.symbol}`, size: "sm", color: "#ffffffBB" },
        { type: "text", text: priceText, size: "4xl", weight: "bold", color: "#ffffff" },
        { type: "text", text: changeText, size: "sm", color: changeColor, margin: "xs" },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingBottom: "8px",
      paddingEnd: "16px",
      contents: [{ type: "text", text: `source: ${r.source}`, size: "xxs", color: "#bbbbbb", align: "end" }],
    },
  };
  if (bodyRows.length > 0) {
    bubble.body = {
      type: "box",
      layout: "vertical",
      paddingTop: "8px",
      paddingBottom: "4px",
      paddingStart: "16px",
      paddingEnd: "16px",
      contents: bodyRows,
    };
  }

  return flex(`${r.symbol}: ${priceText} ${changeText}`, bubble);
}

export function buildCryptoFlex(r: CryptoResult): LineMessage {
  const isUp = r.change24h != null ? r.change24h >= 0 : null;
  const changeColor = isUp === true ? "#4CAF50" : isUp === false ? "#F44336" : "#888888";
  const arrow = isUp === true ? "▲" : isUp === false ? "▼" : "—";

  const priceText =
    r.usd >= 1
      ? `$${r.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `$${r.usd.toFixed(4)}`;
  const changeText =
    r.change24h != null ? `${arrow} ${r.change24h >= 0 ? "+" : ""}${r.change24h.toFixed(2)}% (24h)` : "—";

  const name = r.id.charAt(0).toUpperCase() + r.id.slice(1);

  const bubble = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#4527A0",
      paddingAll: "20px",
      contents: [
        { type: "text", text: `${coinSymbol(r.id)} ${name}`, size: "sm", color: "#ffffffBB" },
        { type: "text", text: priceText, size: "4xl", weight: "bold", color: "#ffffff" },
        { type: "text", text: changeText, size: "sm", color: changeColor, margin: "xs" },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingBottom: "8px",
      paddingEnd: "16px",
      contents: [{ type: "text", text: `source: ${r.source}`, size: "xxs", color: "#bbbbbb", align: "end" }],
    },
  };

  return flex(`${name}: ${priceText} ${changeText}`, bubble);
}

function fmtPrice(amount: number, currency = "USD"): string {
  const sym =
    currency === "USD" ? "$"
    : currency === "THB" ? "฿"
    : currency === "EUR" ? "€"
    : currency === "GBP" ? "£"
    : `${currency} `;
  const abs = Math.abs(amount);
  const formatted =
    abs >= 1000
      ? abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : abs >= 1
        ? abs.toFixed(2)
        : abs.toFixed(4);
  return `${amount < 0 ? "-" : ""}${sym}${formatted}`;
}

function marketLabel(state: string | undefined): string {
  const s = (state ?? "").toUpperCase();
  if (s === "REGULAR") return "Open";
  if (s === "PRE") return "Pre-market";
  if (s === "POST" || s === "POSTPOST") return "After-hours";
  if (s === "") return "—";
  return "Closed";
}

function makeRow(label: string, value: string): unknown {
  return {
    type: "box",
    layout: "horizontal",
    paddingTop: "4px",
    paddingBottom: "4px",
    contents: [
      { type: "text", text: label, size: "sm", flex: 3, color: "#888888" },
      { type: "text", text: value, size: "sm", flex: 4, align: "end", color: "#333333", weight: "bold" },
    ],
  };
}

function coinSymbol(id: string): string {
  const map: Record<string, string> = {
    bitcoin: "₿", ethereum: "Ξ", solana: "◎", dogecoin: "Ð",
  };
  return map[id.toLowerCase()] ?? "🪙";
}
