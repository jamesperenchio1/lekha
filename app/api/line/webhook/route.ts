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
import { classify, clearPending, getPending } from "@/lib/confirm";
import { listAccounts } from "@/lib/tools/google-auth";
import { renderDraftsBlock } from "@/lib/llm/render-drafts";
import { executePendingAll } from "@/lib/pending-runner";
import { appendRecentMedia, listRecentMedia } from "@/lib/memory/recent-media";
import { registerUser } from "@/lib/memory/user-registry";
import { getSettings } from "@/lib/memory/settings";
import { logSent } from "@/lib/memory/sent-log";

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

  // Register so the proactive cron sweep knows about this user.
  await registerUser(userId).catch(() => {});

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

    // If pending actions are awaiting confirmation, intercept.
    const pending = await getPending(userId);
    if (pending.length > 0) {
      const decision = classify(userText);
      if (decision === "yes") {
        await showLoading(userId, 25);
        const result = await executePendingAll(userId, pending);
        await clearPending(userId);
        await reply(event.replyToken, [textMsg(result)]);
        await appendTurn(userId, { role: "user", content: userText, ts: Date.now() });
        await appendTurn(userId, { role: "assistant", content: result, ts: Date.now() });
        return;
      }
      if (decision === "no") {
        await clearPending(userId);
        await reply(event.replyToken, [
          textMsg(`Cancelled ${pending.length === 1 ? "that" : `all ${pending.length}`}.`),
        ]);
        return;
      }
      // Otherwise: discard the pending list and let the model handle the new instruction.
      await clearPending(userId);
    }

    await respondToText(event.replyToken, userId, profile, userText);
    return;
  }

  // Image messages → multimodal turn (Gemini sees it AND we stash it for attach).
  if (message.type === "image" && "id" in message && typeof message.id === "string") {
    await respondToImage(event.replyToken, userId, profile, message.id);
    return;
  }

  // Video / audio / file → stash for attachment, agent loop handles the response.
  if (
    (message.type === "video" || message.type === "audio" || message.type === "file") &&
    "id" in message &&
    typeof message.id === "string"
  ) {
    await respondToOtherMedia(
      event.replyToken,
      userId,
      profile,
      message.id,
      message.type,
      "fileName" in message && typeof message.fileName === "string" ? message.fileName : undefined,
      "fileSize" in message && typeof message.fileSize === "number" ? message.fileSize : undefined,
      "duration" in message && typeof message.duration === "number" ? message.duration : undefined,
    );
    return;
  }

  if (message.type === "sticker") {
    await reply(event.replyToken, [textMsg("Cute sticker. Send me text, a photo, or a file if you'd like me to do something with it.")]);
    return;
  }

  await reply(event.replyToken, [
    textMsg("I didn't recognize that message type. Try text, a photo, video, audio, or a file."),
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
    await appendRecentMedia(userId, {
      kind: "image",
      messageId,
      contentType,
      sizeBytes: bytes.byteLength,
      ts: Date.now(),
    });
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

async function respondToOtherMedia(
  replyToken: string,
  userId: string,
  profile: { displayName: string },
  messageId: string,
  kind: "video" | "audio" | "file",
  fileName: string | undefined,
  fileSize: number | undefined,
  durationMs: number | undefined,
): Promise<void> {
  await showLoading(userId, 15);

  // We don't fetch the bytes now — just record the LINE pointer + metadata.
  // Bytes are pulled at send time (cheap, avoids burning Redis on big files).
  // To get the contentType we'd need to HEAD-request LINE; do a lightweight
  // probe so the model can tell the user.
  let contentType = guessMimeFromFilename(fileName) ?? defaultMimeForKind(kind);
  try {
    const head = await fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${env().LINE_CHANNEL_ACCESS_TOKEN}`, Range: "bytes=0-0" },
      },
    );
    const ct = head.headers.get("content-type");
    // Drain the body to free the underlying socket — fetch() will leak it otherwise.
    await head.body?.cancel().catch(() => {});
    if (ct) contentType = ct;
  } catch {
    // best effort
  }

  await appendRecentMedia(userId, {
    kind,
    messageId,
    contentType,
    fileName,
    sizeBytes: fileSize,
    durationMs,
    ts: Date.now(),
  });

  const description = [
    `(User just sent a ${kind} via LINE.`,
    fileName ? ` Filename: "${fileName}".` : "",
    fileSize ? ` Size: ~${(fileSize / 1024).toFixed(0)} KB.` : "",
    durationMs ? ` Duration: ${(durationMs / 1000).toFixed(1)}s.` : "",
    ` Mime: ${contentType}.`,
    " It's staged for attachment via attach_recent_media on draft_email if they want it sent somewhere.)",
  ].join("");

  const history = await loadHistory(userId);
  const facts = await loadFacts(userId);
  const messages: ModelMessage[] = [
    ...history.map<ModelMessage>((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: description },
  ];

  const replyText = await runAgent(userId, profile, facts, messages);
  await reply(replyToken, [textMsg(replyText)]);

  await appendTurn(userId, {
    role: "user",
    content: `[sent a ${kind}${fileName ? `: ${fileName}` : ""}]`,
    ts: Date.now(),
  });
  await appendTurn(userId, { role: "assistant", content: replyText, ts: Date.now() });
  await maybeExtractFacts(userId);
}

function guessMimeFromFilename(name: string | undefined): string | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return null;
}

function defaultMimeForKind(kind: "video" | "audio" | "file"): string {
  if (kind === "video") return "video/mp4";
  if (kind === "audio") return "audio/m4a";
  return "application/octet-stream";
}

async function runAgent(
  userId: string,
  profile: { displayName: string },
  facts: Awaited<ReturnType<typeof loadFacts>>,
  messages: ModelMessage[],
): Promise<string> {
  const [accounts, staged, settings] = await Promise.all([
    listAccounts(userId),
    listRecentMedia(userId),
    getSettings(userId),
  ]);
  const accountsBlock = accounts.accounts.length
    ? `\n\nConnected Google accounts: ${accounts.accounts
        .map((a) => `${a.email}${a.email === accounts.activeEmail ? " (active)" : ""}`)
        .join(", ")}.`
    : "";
  const recentBlock = staged.length
    ? `\n\nLINE files staged for attachment (1-indexed, oldest first):\n${staged
        .map((m, i) => {
          const ago = Math.round((Date.now() - m.ts) / 60_000);
          const parts = [
            `${i + 1}. ${m.kind}`,
            m.fileName ? `"${m.fileName}"` : null,
            `(${m.contentType}`,
            m.sizeBytes ? `, ${(m.sizeBytes / 1024).toFixed(0)} KB` : "",
            `)`,
            `— ${ago}m ago`,
          ];
          return parts.filter(Boolean).join(" ");
        })
        .join("\n")}\nUse \`attach_recent_media: true\` to attach all of them, or \`attach_recent_media_indexes: [n,…]\` to pick specific ones.`
    : "";
  const system =
    buildSystemPrompt(factsToPromptBlock(facts), profile, settings) +
    accountsBlock +
    recentBlock;

  try {
    const result = await generateText({
      model: chatModel(),
      system,
      messages,
      tools: toolsForUser(userId),
      stopWhen: stepCountIs(8),
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

    // Collect tool calls + outputs across steps.
    const allCalls: { toolName: string; input: unknown }[] = [];
    let authNeeded: { connectUrl: string; reason: string } | null = null;
    let apiDisabled: { api: string; enableUrl: string | null; message: string } | null = null;
    let googleErr: { status: number | null; message: string } | null = null;
    for (const step of result.steps) {
      for (const c of step.toolCalls) {
        if (!c) continue;
        allCalls.push({ toolName: c.toolName, input: c.input });
      }
      for (const tr of step.toolResults) {
        if (!tr) continue;
        const value = extractToolValue((tr as { output?: unknown }).output);
        if (!value || typeof value !== "object") continue;
        const v = value as Record<string, unknown>;
        if (v.need_google_auth && typeof v.connect_url === "string") {
          authNeeded = { connectUrl: v.connect_url, reason: typeof v.reason === "string" ? v.reason : "" };
        } else if (v.google_api_disabled) {
          apiDisabled = {
            api: typeof v.api === "string" ? v.api : "Google API",
            enableUrl: typeof v.enable_url === "string" ? v.enable_url : null,
            message: typeof v.message === "string" ? v.message : "",
          };
        } else if (v.google_error) {
          googleErr = {
            status: typeof v.status === "number" ? v.status : null,
            message: typeof v.message === "string" ? v.message : "",
          };
        }
      }
    }

    // Override priority: auth → API disabled → other Google error.
    if (authNeeded) {
      return `I need to (re)authorize your Google account first — the stored token is missing the required scopes.\n\n${authNeeded.connectUrl}\n\n(Link expires in 10 min. After you connect, I'll pick up where we left off automatically.)`;
    }
    if (apiDisabled) {
      const enableHint = apiDisabled.enableUrl
        ? `\n\nEnable it here:\n${apiDisabled.enableUrl}`
        : `\n\nEnable it in Google Cloud Console → APIs & Services → Library.`;
      return `Google says the ${apiDisabled.api} isn't enabled in your Cloud project.${enableHint}\n\nGive it ~1 min to propagate after enabling, then try again.`;
    }
    if (googleErr) {
      const status = googleErr.status ? ` (HTTP ${googleErr.status})` : "";
      return `Google API error${status}: ${googleErr.message}`;
    }

    const draftBlock = renderDraftsBlock(allCalls, accounts.activeEmail);
    const modelText = result.text?.trim() ?? "";
    if (draftBlock) {
      const intro = modelText.length > 0 && modelText.length < 240 ? `${modelText}\n\n` : "";
      return `${intro}${draftBlock}`;
    }
    return modelText.length > 0 ? modelText : "(…)";
  } catch (err) {
    // Tools throw typed errors when they need user input. Translate them to chat.
    const inner = unwrap(err);
    if (inner instanceof GoogleAuthRequired) {
      const url = await buildConnectUrl(userId);
      return `To do that I need access to your Google account. Connect here (link expires in 10 min):\n${url}`;
    }
    if (inner instanceof NeedsConfirmation) {
      return inner.message;
    }
    if (inner instanceof RateLimited) {
      return `I'm being rate-limited. Try again in ~${inner.retryAfterSec}s.`;
    }
    // Surface known Gemini rate-limit errors with a clean retry-after message.
    const quota = parseQuotaError(err);
    if (quota) {
      console.warn("[agent] gemini quota hit", { retryAfter: quota.retryAfterSec });
      return `I'm out of free Gemini quota for the next ~${quota.retryAfterSec}s. Try again then.`;
    }
    console.error("[agent] unhandled", err);
    return "Something went sideways on my end. Try again in a moment?";
  }
}

/** Extract the actual value from an AI SDK tool result output, which can be
 * either { type: 'json', value } or just a value depending on shape. */
function extractToolValue(output: unknown): unknown {
  if (output && typeof output === "object") {
    const o = output as { type?: string; value?: unknown };
    if (o.type === "json" && "value" in o) return o.value;
    return output;
  }
  return output;
}

function parseQuotaError(err: unknown): { retryAfterSec: number } | null {
  const text = (() => {
    if (err instanceof Error) {
      const cause = (err as { cause?: unknown }).cause;
      const causeMsg = cause instanceof Error ? cause.message : "";
      return `${err.name} ${err.message} ${causeMsg}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  })();
  if (!/quota|rate.?limit|RESOURCE_EXHAUSTED|429/i.test(text)) return null;
  const m = text.match(/retry in (\d+(?:\.\d+)?)s/i);
  const retryAfterSec = m ? Math.ceil(parseFloat(m[1]!)) : 60;
  return { retryAfterSec };
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

async function maybeExtractFacts(userId: string): Promise<void> {
  const n = await turnCounter(userId);
  if (n % 10 !== 0) return;
  const history = await loadHistory(userId);
  // Fire-and-forget — don't block reply.
  extractAndMergeFacts(userId, history).catch((err) =>
    console.warn("[facts] background extract failed", err),
  );
}
