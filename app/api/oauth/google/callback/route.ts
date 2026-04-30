import { NextResponse, type NextRequest } from "next/server";
import { completeOAuth } from "@/lib/tools/google-auth";
import { push, text as textMsg } from "@/lib/line/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlPage(`Google said: ${error}. You can close this tab.`);
  }
  if (!code || !state) {
    return htmlPage("Missing code or state. Try the connect link again.");
  }

  let userId: string;
  try {
    userId = await completeOAuth(code, state);
  } catch (err) {
    console.error("[oauth] callback failed", err);
    return htmlPage("Couldn't complete the connection. Ask the bot for a new link and try again.");
  }

  // Best-effort LINE push so they know to switch back to the chat.
  push(userId, [textMsg("✅ Google connected. Try your last request again!")]).catch(() => {});

  return htmlPage("✅ Connected! Return to LINE and try your request again.");
}

function htmlPage(body: string) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Lekha</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 520px; margin: 10vh auto; padding: 2rem; line-height: 1.5; }
    h1 { font-size: 1.4rem; }
  </style>
</head>
<body>
  <h1>Lekha</h1>
  <p>${escapeHtml(body)}</p>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
