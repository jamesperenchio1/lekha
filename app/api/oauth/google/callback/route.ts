import { NextResponse, type NextRequest } from "next/server";
import { completeOAuth } from "@/lib/tools/google-auth";
import { push, text as textMsg } from "@/lib/line/client";
import { clearPending, getPending } from "@/lib/confirm";
import { executePendingAll } from "@/lib/pending-runner";

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

  let result: { userId: string; email: string };
  try {
    result = await completeOAuth(code, state);
  } catch (err) {
    console.error("[oauth] callback failed", err);
    return htmlPage(
      `Couldn't complete the connection. ${err instanceof Error ? err.message : ""}`,
    );
  }
  const { userId, email } = result;

  // If the user was waiting on this exact connection (e.g. to send an email),
  // execute the pending action now and push the result back to LINE.
  let resumed = false;
  try {
    const pending = await getPending(userId);
    if (pending.length > 0) {
      const replyText = await executePendingAll(userId, pending);
      await clearPending(userId);
      await push(userId, [textMsg(replyText)]);
      resumed = true;
    }
  } catch (err) {
    console.warn("[oauth] auto-resume failed", err);
  }

  // Always nudge them back to LINE with confirmation of which account is now active.
  push(userId, [
    textMsg(
      resumed
        ? `(Connected ${email} — picked up your last request automatically.)`
        : `✅ Connected ${email}. You can switch accounts anytime by saying "use my other Google account".`,
    ),
  ]).catch(() => {});

  return htmlPage(
    resumed
      ? `✅ Connected ${email}. I picked up your request automatically — head back to LINE.`
      : `✅ Connected ${email}. Return to LINE and try your request again.`,
  );
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
