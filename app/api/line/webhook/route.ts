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
  getProfile,
} from "@/lib/line/client";
import { env } from "@/lib/env";
import { redis } from "@/lib/memory/redis";
import { appendTurn, loadHistory, turnCounter } from "@/lib/memory/history";
import { loadFacts, factsToPromptBlock } from "@/lib/memory/facts";
import { getOrCreateProfile } from "@/lib/memory/profile";
import { isAllowed, addToAllowlist, removeFromAllowlist, listAllowed } from "@/lib/memory/allowlist";
import { chatModel, fallbackChatModels } from "@/lib/llm/provider";
import { isGeminiDown, markGeminiDown } from "@/lib/llm/health";
import type { LanguageModel } from "ai";
import { buildSystemPrompt } from "@/lib/llm/prompts";
import { extractAndMergeFacts } from "@/lib/llm/extract-facts";
import { toolsForUser, coreToolsForUser } from "@/lib/tools";
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

  // Allowlist gate — runs for every event type before any other logic.
  // Admins always pass. Everyone else must be on the allowlist.
  const adminIds = new Set(
    (env().ADMIN_LINE_USER_ID ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const isAdmin = (id: string) => adminIds.has(id);
  const eventUserId = event.source?.userId;
  if (eventUserId && adminIds.size > 0 && !isAdmin(eventUserId)) {
    const allowed = await isAllowed(eventUserId);
    if (!allowed) {
      if ("replyToken" in event && event.replyToken) {
        await reply(event.replyToken, [
          textMsg(`This is a private assistant.\n\nYour LINE ID:\n${eventUserId}\n\nSend this to the admin to request access.`),
        ]);
      }
      return;
    }
  }

  if (event.type === "follow") {
    const userId = event.source?.userId;
    if (!userId || !("replyToken" in event)) return;
    const profile = await getOrCreateProfile(userId);
    const name = profile.displayName && profile.displayName !== "friend" ? ` ${profile.displayName}` : "";
    const connectUrl = await buildConnectUrl(userId).catch(() => null);
    await reply(event.replyToken, [
      textMsg(
        `Hi${name}! I'm Lekha, your personal assistant 👋\n\nI can set reminders, search the web, look up stocks or weather, read photos, and more.\n\nType "help" to see everything I can do. To connect Google (Gmail, Calendar, Drive), type "connect google".`,
      ),
    ]);
    return;
  }

  if (event.type !== "message") return;

  const userId = event.source?.userId;
  if (!userId) return;
  if (!("replyToken" in event) || !("message" in event)) return;
  const message = event.message;

  // Run all independent setup in parallel: rate limit, profile, pending queue.
  // registerUser is fire-and-forget — cron sweep needs it but nothing here depends on it.
  registerUser(userId).catch(() => {});
  const [rl, profile, pending] = await Promise.all([
    checkRateLimit(userId),
    getOrCreateProfile(userId),
    getPending(userId),
  ]);

  if (!rl.ok) {
    await reply(event.replyToken, [
      textMsg(`Easy there — give me a sec. Try again in ~${rl.retryAfterSec}s.`),
    ]);
    return;
  }

  // Handle text messages (with confirmation routing).
  if (message.type === "text" && "text" in message && typeof message.text === "string") {
    const userText = message.text.trim();

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

    // /myid — lets anyone look up their own LINE userId (needed to request allowlist access).
    if (/^\/myid$/i.test(userText)) {
      await reply(event.replyToken, [textMsg(`Your LINE ID:\n${userId}`)]);
      return;
    }

    // Admin-only management commands.
    if (isAdmin(userId)) {
      const addMatch = userText.match(/^\/allow\s+(U\w+)$/i);
      const remMatch = userText.match(/^\/remove\s+(U\w+)$/i);
      if (addMatch) {
        await addToAllowlist(addMatch[1]!);
        await reply(event.replyToken, [textMsg(`✅ Added ${addMatch[1]} to the allowlist.`)]);
        return;
      }
      if (remMatch) {
        await removeFromAllowlist(remMatch[1]!);
        await reply(event.replyToken, [textMsg(`🗑 Removed ${remMatch[1]} from the allowlist.`)]);
        return;
      }
      if (/^\/users$/i.test(userText)) {
        const list = await listAllowed();
        if (!list.length) {
          await reply(event.replyToken, [textMsg("Allowed users (0):\n\n(nobody yet)")]);
          return;
        }
        const entries = await Promise.all(
          list.map(async (id) => {
            const p = await getProfile(id).catch(() => null);
            return p?.displayName ? `${p.displayName} (${id})` : id;
          }),
        );
        await reply(event.replyToken, [textMsg(`Allowed users (${list.length}):\n\n${entries.join("\n")}`)]);
        return;
      }
    }

    // Shortcut: help command never needs an LLM call.
    const helpTrigger = /^\/?(help|what can you do|capabilities)$/i;
    if (helpTrigger.test(userText)) {
      const { HELP_TEXT } = await import("@/lib/tools/help");
      await reply(event.replyToken, [textMsg(HELP_TEXT)]);
      return;
    }

    // Shortcut: "connect google" generates the OAuth URL without hitting the LLM.
    if (/^connect\s+google$/i.test(userText)) {
      const url = await buildConnectUrl(userId).catch(() => null);
      const msg = url
        ? `Connect your Google account here (link expires in 10 min):\n${url}`
        : "Couldn't generate a connect link — make sure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.";
      await reply(event.replyToken, [textMsg(msg)]);
      return;
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
  const t0 = Date.now();
  showLoading(userId, 60).catch(() => {});  // fire-and-forget; LLM doesn't wait for LINE ack
  const [history, facts] = await Promise.all([loadHistory(userId), loadFacts(userId)]);
  console.log("[webhook] preload done", { ms: Date.now() - t0 });
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
  const t0 = Date.now();
  showLoading(userId, 60).catch(() => {});
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

  const [history, facts] = await Promise.all([loadHistory(userId), loadFacts(userId)]);
  console.log("[webhook] preload done", { ms: Date.now() - t0 });
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
  await showLoading(userId, 60);

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

  // Detect whether the conversation has a multimodal user turn (image/audio/video/file part).
  // If so, the Groq fallback (text-only) can't service it — Gemini-only.
  const hasMultimodal = messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => {
        if (typeof p !== "object" || !p) return false;
        const t = (p as { type?: string }).type;
        return t === "image" || t === "file";
      }),
  );

  // Build a minimal system prompt for the fallback path. We explicitly enumerate
  // the available tools because some Groq-hosted models (Llama 4 in particular)
  // will refuse a request with "I don't have access to X" if the tool isn't
  // mentioned in the system prompt — even though the schema IS being passed to
  // them through the API. Listing them here forces the model to actually use them.
  const slimLocationHint = settings?.location ? `\nUser's location: ${settings.location}.` : "";
  const slimSystem = `You are Lekha (เลขา), ${profile.displayName}'s personal secretary on LINE. You are a lady — in Thai always use ค่ะ, never ครับ. Warm but professional, concise (1-3 sentences). Match the user's language. Never reveal the underlying AI model or provider; if asked, say you're Lekha, a personal assistant, and leave it at that. Current time: ${new Date().toISOString()} (UTC).${slimLocationHint}

You have these tools available right now — use them whenever the user's request matches. NEVER reply 'I don't have access to X' if a matching tool exists below; CALL the tool:

- stock_price(ticker)         — current stock price.
- stock_history(ticker, range) — historical movement: 1mo / 3mo / 6mo / 1y / 2y / 5y / ytd / max. USE for "1-year movement of X" / "YTD performance".
- crypto_price(coin)          — current crypto price (bitcoin, ethereum, btc, eth, …). USE THIS for any crypto question.
- fx_rate(from, to, amount)   — currency conversion. USE THIS for any FX question.
- weather(location)           — current weather + 3-day forecast. USE THIS for any weather question. If no location is known, ASK the user before calling.
- news_search(query, days?)   — recent news headlines + sources. USE THIS for any news question.
- web_search(query)           — general web search for everything else (articles, who-is-X). NOT for stocks/crypto/weather/news.
- set_reminder(when, message) — schedule a reminder push.
- list_reminders / list_tasks / list_memories — show stored items.
- add_task(title, dueAt?)     — add a persistent task.
- complete_task(id)           — mark a task done.
- remember(fact)              — save a durable fact about the user.
- contacts_search(query)      — find an email/phone in the user's Google Contacts.
- draft_email({to, subject, body, …})       — compose an email (queues for YES confirm). If the user sent a file in LINE (staged below), pass attach_recent_media: true or attach_recent_media_indexes: [n] — do NOT use drive_search for files the user just uploaded in chat.
- draft_calendar_event({summary, startISO, endISO, attendees?, …}) — compose a calendar event.
- calendar_today / calendar_week — see today's or this week's events.
- ocr_image / transcribe_audio — extract text from a recently-sent image / voice memo.
- show_help                   — list all capabilities to the user.

If none of these tools fit the question, answer briefly from your own knowledge. Don't make up tool capabilities that aren't listed.

CRITICAL: when a tool returns { ok: false, error: "..." }, RELAY THE EXACT ERROR to the user (one short sentence). Never say "I'm having a technical hiccup" or "let me get that sorted" — those are useless evasions. Tell the user what actually broke so they can react.

SOURCE RULE: when presenting live data (prices, rates, weather), always cite the source at the end in this exact format: "35.06 THB (source: Frankfurter)" or "28°C (source: wttr.in)".` + recentBlock;

  try {
    const result = await runWithCascade({
      hasMultimodal,
      system,
      messages,
      tools: toolsForUser(userId),
      slimSystem,
      slimTools: coreToolsForUser(userId),
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
      const isReauth = authNeeded.reason.includes("scopes");
      const intro = isReauth
        ? "Your Google account needs a quick permission update to access calendar and Gmail features."
        : "I need access to your Google account to do that.";
      return `${intro}\n\nType "connect google" to reconnect — it only takes a few seconds and you'll only need to do this once.\n\n${authNeeded.connectUrl}`;
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

    // Collect tool errors. If the model soft-apologized instead of relaying the
    // actual error, override with the real message so the user knows what broke.
    const toolErrors: string[] = [];
    for (const step of result.steps) {
      for (const tr of step.toolResults) {
        const value = extractToolValue((tr as { output?: unknown }).output);
        if (value && typeof value === "object") {
          const v = value as Record<string, unknown>;
          if (v.ok === false && typeof v.error === "string") {
            const toolName = (tr as { toolName?: string }).toolName ?? "tool";
            toolErrors.push(`${toolName}: ${v.error}`);
          }
        }
      }
    }

    const draftBlock = renderDraftsBlock(allCalls, accounts.activeEmail);
    const modelText = result.text?.trim() ?? "";

    // If there were tool errors and the model's response doesn't mention the actual
    // error text (i.e. it soft-apologized), surface the real errors instead.
    if (toolErrors.length > 0 && !draftBlock) {
      const allErrorsPresent = toolErrors.every((e) => modelText.includes(e.split(": ").slice(1).join(": ")));
      if (!allErrorsPresent) {
        console.warn("[agent] model soft-apologized — overriding with real tool errors", toolErrors);
        return toolErrors.join("\n");
      }
    }

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
    // VERBOSE DEBUG MODE — surface the entire error chain to LINE so we can
    // diagnose remaining failures in production. Revert when stable.
    if (err instanceof AgentTimeoutError) {
      console.warn("[agent] timeout", { seconds: err.seconds });
      return `⏱ Timed out after ${err.seconds}s. Both Gemini and Groq took too long. Try again in a sec.`;
    }
    if (err instanceof Error && err.name === "AllProvidersFailed") {
      console.error("[agent] all providers failed");
      return `🚦 All providers failed:\n\n${err.message}`;
    }
    const quota = parseQuotaError(err);
    if (quota) {
      console.warn("[agent] gemini quota/overload (no fallback configured)", { retryAfter: quota.retryAfterSec });
      return `🚦 Gemini overloaded for ~${quota.retryAfterSec}s.\n\n${verboseError(err)}`;
    }
    console.error("[agent] unhandled", err);
    return `🐛 Unhandled agent error:\n\n${verboseError(err)}`;
  }
}

/** Dump everything we can extract from an error — class, message, cause chain, response text. */
function verboseError(err: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  let depth = 0;
  while (cur && typeof cur === "object" && !seen.has(cur) && depth < 4) {
    seen.add(cur);
    const e = cur as {
      name?: string;
      message?: string;
      statusCode?: number;
      responseBody?: string;
      url?: string;
      cause?: unknown;
    };
    const part = [
      `${depth === 0 ? "" : "↳ "}${e.name ?? "Error"}: ${e.message ?? "(no message)"}`,
      e.statusCode ? `  status: ${e.statusCode}` : null,
      e.url ? `  url: ${e.url}` : null,
      e.responseBody ? `  body: ${String(e.responseBody).slice(0, 400)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    lines.push(part);
    cur = e.cause;
    depth++;
  }
  const out = lines.join("\n\n");
  return out.length > 1500 ? `${out.slice(0, 1500)}\n…(truncated)` : out;
}

/**
 * Try Gemini first; on quota error fall back to Groq for text-only conversations.
 * Multimodal turns can't fall back (Groq has no vision), so they re-throw and the
 * caller surfaces a friendly "out of free quota" message.
 */
/**
 * Gemini primary (smarter at tool routing), Groq fallback for text-only turns
 * when Gemini hits a rate limit. `maxRetries: 0` disables the SDK's built-in
 * exponential backoff so a quota error cascades to Groq in milliseconds, not
 * after ~10s of silent retries.
 */
async function runWithCascade<T extends ReturnType<typeof toolsForUser>>(opts: {
  hasMultimodal: boolean;
  system: string;
  messages: ModelMessage[];
  tools: T;
  /** Optional slim variants used only on the Groq fallback path (saves TPM, helps weaker models). */
  slimSystem?: string;
  slimTools?: ReturnType<typeof coreToolsForUser>;
}) {
  const tStart = Date.now();
  // If we marked Gemini as down recently (after a 503/quota), skip it entirely
  // and go straight to the Groq fallback path. Avoids burning ~5s per request
  // hitting an upstream that's known to be unhealthy.
  let geminiRanToolCalls = false;
  try {
    const skipGemini = !opts.hasMultimodal && (await isGeminiDown());
    if (skipGemini) {
      console.log("[agent] skipping gemini (recent overload mark)");
      throw new Error("gemini-skipped");
    }
    const r = await withTimeout(
      generateText({
        model: chatModel(),
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
        temperature: 0.4,
        stopWhen: stepCountIs(3),
        maxRetries: 0,
        onStepFinish: (step) => {
          if (step.toolCalls.length > 0) geminiRanToolCalls = true;
          console.log("[agent] gemini step", {
            ms: Date.now() - tStart,
            toolCalls: step.toolCalls.map((c) => c?.toolName),
            toolResults: step.toolResults.map((r) => ({
              tool: (r as { toolName?: string }).toolName,
              result: JSON.stringify((r as { output?: unknown }).output ?? r).slice(0, 300),
            })),
            text: step.text?.slice(0, 200) || undefined,
            finish: step.finishReason,
          });
        },
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
      }),
      20_000,
    );
    console.log("[agent] gemini done", { ms: Date.now() - tStart, steps: r.steps.length });
    return r;
  } catch (err) {
    const isTimeout = err instanceof AgentTimeoutError;
    const isSkip = err instanceof Error && err.message === "gemini-skipped";
    const quota = parseQuotaError(err);
    if (!quota && !isTimeout && !isSkip) throw err;
    const fallbacks = fallbackChatModels();
    if (!fallbacks.length || opts.hasMultimodal) throw err;
    // If Gemini already executed tool calls before timing out, the side effects
    // (reminder scheduled, email drafted, etc.) already happened. Cascading to
    // Groq would re-run those same tools and cause duplicates.
    if (isTimeout && geminiRanToolCalls) {
      console.warn("[agent] gemini timed out after tool calls — skipping cascade to avoid duplicates");
      throw err;
    }
    if (!isSkip) {
      // Mark Gemini down so the next ~60s of requests skip it.
      await markGeminiDown(60).catch(() => {});
    }
    console.warn(
      "[agent] cascading to groq",
      isSkip ? "(gemini pre-skipped)" : isTimeout ? "(gemini timeout)" : `(gemini quota/overload, retry-after ~${quota?.retryAfterSec}s)`,
      { totalMs: Date.now() - tStart, fallbackModels: fallbacks.length },
    );
    // On the fallback path, ship a slim system prompt + the core tool subset.
    // The full registry is ~50 tools (~5K tokens of descriptions) which blows
    // Groq's tighter TPM limits and confuses weaker models.
    const slimSystem = opts.slimSystem ?? opts.system;
    const slimTools = opts.slimTools ?? opts.tools;
    const groqErrors: { model: string; error: unknown }[] = [];
    for (const m of fallbacks) {
      const tGroq = Date.now();
      const modelLabel =
        (m as unknown as { modelId?: string }).modelId ??
        (m as unknown as { provider?: string }).provider ??
        "groq";
      try {
        const r = await withTimeout(
          generateText({
            model: m as LanguageModel,
            system: slimSystem,
            messages: opts.messages,
            tools: slimTools,
            temperature: 0.4,
            stopWhen: stepCountIs(3),
            maxRetries: 0,
            onStepFinish: (step) => {
              console.log("[agent] groq step", {
                model: modelLabel,
                ms: Date.now() - tGroq,
                toolCalls: step.toolCalls.map((c) => c?.toolName),
                toolResults: step.toolResults.map((r) => ({
                  tool: (r as { toolName?: string }).toolName,
                  result: JSON.stringify((r as { output?: unknown }).output ?? r).slice(0, 300),
                })),
                text: step.text?.slice(0, 200) || undefined,
                finish: step.finishReason,
              });
            },
          }),
          45_000,
        );
        console.log("[agent] groq done", { model: modelLabel, ms: Date.now() - tGroq, steps: r.steps.length });
        return r;
      } catch (groqErr) {
        console.warn("[agent] groq fallback failed", { model: modelLabel, err: groqErr instanceof Error ? `${groqErr.name}: ${groqErr.message}` : groqErr });
        groqErrors.push({ model: modelLabel, error: groqErr });
      }
    }
    // All fallbacks failed — wrap original error with the groq attempts so the
    // user-facing dump shows what each provider said.
    const wrapped = new Error(
      `Both providers failed.\n\nGEMINI:\n${verboseError(err)}\n\nGROQ ATTEMPTS:\n${groqErrors
        .map((g) => `--- ${g.model} ---\n${verboseError(g.error)}`)
        .join("\n\n")}`,
    );
    wrapped.name = "AllProvidersFailed";
    throw wrapped;
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
  // Match real quota AND transient overload AND any AI SDK API call error.
  // AI_APICallError is the SDK's wrapper for ANY provider HTTP error — almost
  // always transient at the provider, so cascading to Groq is the right move.
  if (
    !/quota|rate.?limit|RESOURCE_EXHAUSTED|429|UNAVAILABLE|overloaded|503|500|502|504|INTERNAL|timeout|temporarily|AI_APICallError|AI_RetryError|fetch failed|ECONN|ENOTFOUND/i.test(
      text,
    )
  ) {
    return null;
  }
  const m = text.match(/retry in (\d+(?:\.\d+)?)s/i);
  const retryAfterSec = m ? Math.ceil(parseFloat(m[1]!)) : 30;
  return { retryAfterSec };
}

class AgentTimeoutError extends Error {
  constructor(public readonly seconds: number) {
    super(`Agent call exceeded ${seconds}s`);
    this.name = "AgentTimeoutError";
  }
}

/** Race a promise against a timeout. Throws AgentTimeoutError on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new AgentTimeoutError(Math.round(ms / 1000))), ms),
    ),
  ]);
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
