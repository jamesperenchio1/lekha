import { env } from "@/lib/env";

const API = "https://api.line.me/v2/bot";
const DATA_API = "https://api-data.line.me/v2/bot";

type TextMessage = { type: "text"; text: string };
export type LineMessage = TextMessage;

function authHeaders() {
  return {
    Authorization: `Bearer ${env().LINE_CHANNEL_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * Reply to a message using a one-shot reply token (~1min validity).
 * Falls back silently if expired/used; caller should switch to push.
 */
export async function reply(replyToken: string, messages: LineMessage[]): Promise<boolean> {
  const r = await fetch(`${API}/message/reply`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!r.ok) {
    console.warn("[line] reply failed", r.status, await safeText(r));
    return false;
  }
  return true;
}

/**
 * Push a message to a user (counts against monthly quota on free plan).
 */
export async function push(to: string, messages: LineMessage[]): Promise<boolean> {
  const r = await fetch(`${API}/message/push`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ to, messages }),
  });
  if (!r.ok) {
    console.warn("[line] push failed", r.status, await safeText(r));
    return false;
  }
  return true;
}

/**
 * Reply if the token is fresh, else push. Returns the method used.
 */
export async function replyOrPush(
  to: string,
  replyToken: string | undefined,
  messages: LineMessage[],
): Promise<"reply" | "push" | "failed"> {
  if (replyToken) {
    const ok = await reply(replyToken, messages);
    if (ok) return "reply";
  }
  const ok = await push(to, messages);
  return ok ? "push" : "failed";
}

/**
 * Show a typing indicator to the user for up to ~20s while we work.
 */
export async function showLoading(chatId: string, seconds = 20): Promise<void> {
  await fetch(`${API}/chat/loading/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ chatId, loadingSeconds: clamp(seconds, 5, 60) }),
  }).catch(() => {});
}

/**
 * Fetch the binary content of an image/audio/video message.
 */
export async function getMessageContent(messageId: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
}> {
  const r = await fetch(`${DATA_API}/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${env().LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!r.ok) throw new Error(`getMessageContent ${r.status}`);
  const ct = r.headers.get("content-type") ?? "application/octet-stream";
  const buf = new Uint8Array(await r.arrayBuffer());
  return { bytes: buf, contentType: ct };
}

/**
 * Get a user's display name (best effort).
 */
export async function getProfile(userId: string): Promise<{ displayName: string } | null> {
  const r = await fetch(`${API}/profile/${userId}`, {
    headers: { Authorization: `Bearer ${env().LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!r.ok) return null;
  return (await r.json()) as { displayName: string };
}

export function text(s: string): TextMessage {
  // LINE caps text messages at 5000 chars.
  return { type: "text", text: s.slice(0, 5000) };
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
