import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { verifyLineSignature } from "@/lib/line/verify";
import { Webhook, type LineEvent } from "@/lib/line/types";
import {
  reply,
  showLoading,
  text as textMsg,
  getMessageContent,
} from "@/lib/line/client";
import { env } from "@/lib/env";
import { redis } from "@/lib/memory/redis";
import { appendTurn, loadHistory, turnCounter } from "@/lib/memory/history";
import { loadFacts, factsToPromptBlock } from "@/lib/memory/facts";
import { getOrCreateProfile, isFirstContact } from "@/lib/memory/profile";
import { chatModel } from "@/lib/llm/provider";
import { buildSystemPrompt } from "@/lib/llm/prompts";
import { extractAndMergeFacts } from "@/lib/llm/extract-facts";
import { toolsForUser } from "@/lib/tools";
import { GoogleAuthRequired, NeedsConfirmation, RateLimited } from "@/lib/errors";
import { buildConnectUrl } from "@/lib/tools/google-auth";
import { checkRateLimit } from "@/lib/ratelimit";
import { classify, clearPending, getPending, type PendingAction } from "@/lib/confirm";
import { sendEmail } from "@/lib/tools/email";
import { createCalendarEvent } from "@/lib/tools/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("x-line-signature");
  if (!verifyLineSignature(raw, sig, env().LINE_CHANNEL_SECRET)) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  let payload;
  try {
    payload = Webhook.parse(JSON.parse(raw));
  } catch (err) {
    console.warn("[webhook] bad payload", err);
    return new NextResponse("bad payload", { status: 400 });
  }

  // Respond 200 immediately; do all real work after the response.
  after(async () => {
    for (const event of payload.events) {
      try {
        await handleEvent(event);
      } catch (err) {
        console.error("[webhook] event handler crashed", err);
      }
    }
  });

  return NextResponse.json({ ok: true });
}

async function handleEvent(event: LineEvent): Promise<void> {
  // Idempotency: drop duplicate webhook deliveries.
  if ("webhookEventId" in event && event.webhookEventId) {
    const seenKey = `seen:${event.webhookEventId}`;
    const set = await redis().set(seenKey, 1, { ex: 60 * 10, nx: true });
    if (set === null) return;
  }

  if (event.type === "follow") {
    const userId = event.source?.userId;
    if (!userId || !("replyToken" in event)) return;
    await getOrCreateProfile(userId);
    await reply(event.replyToken, [
      textMsg(
        "Hi! I'm Lekha, your personal assistant. I can chat, remember things you tell me, set reminders, search the web, look at photos, and (after you connect Google) send email and add to your calendar. Try: \"remind me in 5 minutes to stretch\".",
      ),
    ]);
    return;
  }

  if (event.type !== "message") return;

  const userId = event.source?.userId;
  if (!userId) return;
  if (!("replyToken" in event) || !("message" in event)) return;
  const message = event.message;

  // Rate limit (per LINE userId).
  const rl = await checkRateLimit(userId);
  if (!rl.ok) {
    await reply(event.replyToken, [
      textMsg(`Easy there — give me a sec. Try again in ~${rl.retryAfterSec}s.`),
    ]);
    return;
  }

  // First contact: greet + record profile, but still process the message below.
  if (await isFirstContact(userId)) {
    await getOrCreateProfile(userId);
  }
  const profile = await getOrCreateProfile(userId);

  // Handle text messages (with confirmation routing).
  if (message.type === "text" && "text" in message && typeof message.text === "string") {
    const userText = message.text.trim();

    // If a pending action is awaiting confirmation, intercept.
    const pending = await getPending(userId);
    if (pending) {
      const decision = classify(userText);
      if (decision === "yes") {
        await showLoading(userId, 15);
        const result = await executePending(userId, pending);
        await clearPending(userId);
        await reply(event.replyToken, [textMsg(result)]);
        await appendTurn(userId, { role: "user", content: userText, ts: Date.now() });
        await appendTurn(userId, { role: "assistant", content: result, ts: Date.now() });
        return;
      }
      if (decision === "no") {
        await clearPending(userId);
        await reply(event.replyToken, [textMsg("Cancelled.")]);
        return;
      }
      // Otherwise: discard the pending and let the model handle the new instruction.
      await clearPending(userId);
    }

    await respondToText(event.replyToken, userId, profile, userText);
    return;
  }

  // Image messages → multimodal turn.
  if (message.type === "image" && "id" in message && typeof message.id === "string") {
    await respondToImage(event.replyToken, userId, profile, message.id);
    return;
  }

  // Sticker / audio / video / file → polite acknowledgement for now.
  if (message.type === "sticker") {
    await reply(event.replyToken, [textMsg("Cute sticker. Send me text or a photo if you'd like me to do something with it.")]);
    return;
  }

  await reply(event.replyToken, [
    textMsg("I can read text and images today. Try sending one of those!"),
  ]);
}

async function respondToText(
  replyToken: string,
  userId: string,
  profile: { displayName: string },
  userText: string,
): Promise<void> {
  await showLoading(userId, 20);

  const history = await loadHistory(userId);
  const facts = await loadFacts(userId);
  const messages: ModelMessage[] = [
    ...history.map<ModelMessage>((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: userText },
  ];

  const replyText = await runAgent(userId, profile, facts, messages);
  await reply(replyToken, [textMsg(replyText)]);

  await appendTurn(userId, { role: "user", content: userText, ts: Date.now() });
  await appendTurn(userId, { role: "assistant", content: replyText, ts: Date.now() });

  await maybeExtractFacts(userId);
}

async function respondToImage(
  replyToken: string,
  userId: string,
  profile: { displayName: string },
  messageId: string,
): Promise<void> {
  await showLoading(userId, 25);

  let imagePart: { type: "image"; image: Uint8Array; mediaType: string };
  try {
    const { bytes, contentType } = await getMessageContent(messageId);
    imagePart = { type: "image", image: bytes, mediaType: contentType };
  } catch (err) {
    console.warn("[webhook] image fetch failed", err);
    await reply(replyToken, [textMsg("I couldn't load that image — can you resend it?")]);
    return;
  }

  const history = await loadHistory(userId);
  const facts = await loadFacts(userId);
  const messages: ModelMessage[] = [
    ...history.map<ModelMessage>((t) => ({ role: t.role, content: t.content })),
    {
      role: "user",
      content: [
        { type: "text", text: "(image)" },
        imagePart,
      ],
    },
  ];

  const replyText = await runAgent(userId, profile, facts, messages);
  await reply(replyToken, [textMsg(replyText)]);

  await appendTurn(userId, { role: "user", content: "[sent an image]", ts: Date.now() });
  await appendTurn(userId, { role: "assistant", content: replyText, ts: Date.now() });
  await maybeExtractFacts(userId);
}

async function runAgent(
  userId: string,
  profile: { displayName: string },
  facts: Awaited<ReturnType<typeof loadFacts>>,
  messages: ModelMessage[],
): Promise<string> {
  const system = buildSystemPrompt(factsToPromptBlock(facts), profile);

  try {
    const result = await generateText({
      model: chatModel(),
      system,
      messages,
      tools: toolsForUser(userId),
      stopWhen: stepCountIs(5),
      providerOptions: {
        google: {
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          ],
        },
      },
    });
    const out = result.text?.trim();
    return out && out.length > 0 ? out : "(…)";
  } catch (err) {
    // Tools throw typed errors when they need user input. Translate them to chat.
    const inner = unwrap(err);
    if (inner instanceof GoogleAuthRequired) {
      const url = buildConnectUrl(userId);
      return `To do that I need access to your Google account. Connect here (link expires in 10 min):\n${url}`;
    }
    if (inner instanceof NeedsConfirmation) {
      return inner.message;
    }
    if (inner instanceof RateLimited) {
      return `I'm being rate-limited. Try again in ~${inner.retryAfterSec}s.`;
    }
    console.error("[agent] unhandled", err);
    // Debug: include the error message so we can see it in LINE.
    const detail = errorDetail(err);
    return `Something went sideways: ${detail}`;
  }
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeStr = cause instanceof Error ? ` (cause: ${cause.name}: ${cause.message})` : "";
    return `${err.name}: ${err.message}${causeStr}`.slice(0, 800);
  }
  try {
    return JSON.stringify(err).slice(0, 800);
  } catch {
    return String(err).slice(0, 800);
  }
}

function unwrap(err: unknown): unknown {
  // AI SDK wraps tool errors; dig into common shapes.
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof GoogleAuthRequired) return cur;
    if (cur instanceof NeedsConfirmation) return cur;
    if (cur instanceof RateLimited) return cur;
    const next = (cur as { cause?: unknown; originalError?: unknown }).cause
      ?? (cur as { originalError?: unknown }).originalError;
    if (!next) break;
    cur = next;
  }
  return err;
}

async function executePending(userId: string, action: PendingAction): Promise<string> {
  if (action.kind === "send_email") {
    try {
      await sendEmail(userId, action);
      return `✅ Sent to ${action.to}.`;
    } catch (err) {
      const e = unwrap(err);
      if (e instanceof GoogleAuthRequired) {
        return `I need Google access first. Connect here:\n${buildConnectUrl(userId)}`;
      }
      console.error("[send] failed", err);
      return "I couldn't send that. Want me to try again?";
    }
  }
  if (action.kind === "create_calendar_event") {
    try {
      const r = await createCalendarEvent(userId, action);
      return r.htmlLink ? `✅ Added to your calendar:\n${r.htmlLink}` : "✅ Added to your calendar.";
    } catch (err) {
      const e = unwrap(err);
      if (e instanceof GoogleAuthRequired) {
        return `I need Google access first. Connect here:\n${buildConnectUrl(userId)}`;
      }
      console.error("[calendar] failed", err);
      return "I couldn't add that. Want me to try again?";
    }
  }
  return "Done.";
}

async function maybeExtractFacts(userId: string): Promise<void> {
  const n = await turnCounter(userId);
  if (n % 10 !== 0) return;
  const history = await loadHistory(userId);
  // Fire-and-forget — don't block reply.
  extractAndMergeFacts(userId, history).catch((err) =>
    console.warn("[facts] background extract failed", err),
  );
}
