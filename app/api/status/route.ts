import { NextResponse } from "next/server";
import { redis } from "@/lib/memory/redis";
import { hasFreeKey, hasPaidKey } from "@/lib/llm/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [freeUntil, paidUntil] = await Promise.all([
    redis().get<number>("llm:gemini:free:down_until"),
    redis().get<number>("llm:gemini:paid:down_until"),
  ]);

  const now = Date.now();
  const freeConfigured = hasFreeKey();
  const paidConfigured = hasPaidKey();
  const freeDown = freeUntil != null && now < freeUntil;
  const paidDown = paidUntil != null && now < paidUntil;
  const freeSecsLeft = freeDown && freeUntil != null ? Math.ceil((freeUntil - now) / 1000) : 0;
  const paidSecsLeft = paidDown && paidUntil != null ? Math.ceil((paidUntil - now) / 1000) : 0;

  // Active = first tier with a key configured and not in cooldown (free preferred).
  const activeTier =
    freeConfigured && !freeDown ? "free"
    : paidConfigured && !paidDown ? "paid"
    : "none";

  const dot = (active: boolean) =>
    `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${active ? "#4caf50" : "#f44336"};margin-right:10px;vertical-align:middle;flex-shrink:0"></span>`;

  const tierRow = (
    name: string,
    configured: boolean,
    down: boolean,
    secsLeft: number,
    isActive: boolean,
  ) => {
    if (!configured) return "";
    const status = down
      ? `<span style="color:#f44336;font-size:13px">cooldown ${secsLeft}s</span>`
      : isActive
        ? `<span style="color:#4caf50;font-size:13px">● active</span>`
        : `<span style="color:#888;font-size:13px">standby</span>`;
    return `<div style="display:flex;align-items:center;margin:14px 0;font-size:16px">
      ${dot(!down)}
      <strong style="min-width:48px">${name}</strong>
      <span style="margin-left:12px">${status}</span>
    </div>`;
  };

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="10">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lekha · Tier Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: ui-monospace, "SF Mono", monospace; background: #0f0f0f; color: #e0e0e0; padding: 40px 32px; max-width: 400px; }
    h2 { color: #555; font-size: 11px; letter-spacing: 2px; font-weight: normal; margin-bottom: 28px; }
    .badge { display:inline-block; padding:4px 10px; border-radius:4px; font-size:12px; font-weight:bold; letter-spacing:1px; margin-bottom:28px; }
    .badge-free { background:#1a3a1a; color:#4caf50; border:1px solid #2e5c2e; }
    .badge-paid { background:#3a2a1a; color:#ff9800; border:1px solid #5c4a2e; }
    .badge-none { background:#3a1a1a; color:#f44336; border:1px solid #5c2e2e; }
    .footer { color: #444; font-size: 11px; margin-top: 36px; }
  </style>
</head>
<body>
  <h2>GEMINI TIER STATUS</h2>
  <div class="badge badge-${activeTier}">
    ${activeTier === "none" ? "⚠ ALL TIERS DOWN" : `USING ${activeTier.toUpperCase()}`}
  </div>
  ${tierRow("free", freeConfigured, freeDown, freeSecsLeft, activeTier === "free")}
  ${tierRow("paid", paidConfigured, paidDown, paidSecsLeft, activeTier === "paid")}
  <div class="footer">refreshes every 10s &nbsp;·&nbsp; ${new Date().toUTCString()}</div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
