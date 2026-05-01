# Lekha

A personal AI assistant that lives in [LINE](https://line.me). Add the Official Account, message it like a friend, and it can chat, remember things about you, set reminders, search the web, look at photos you send, manage your Google Calendar, search your Google Drive, and send email **from your own Gmail with real attachments** — including files you forwarded to it directly in LINE.

Built on Next.js 16 + Vercel AI SDK v6 + Gemini, deployed on Vercel Functions. Public by design — every LINE user who adds the bot gets isolated memory, OAuths their own Google account(s), and is rate-limited individually.

---

## Table of contents

- [What it does](#what-it-does)
- [Quickstart](#quickstart-from-zero)
- [Architecture](#architecture)
- [Tools the bot has](#tools-the-bot-has)
- [Memory model](#memory-model)
- [Multi-account Google support](#multi-account-google-support)
- [Attachment system (Drive + LINE media batching)](#attachment-system)
- [Confirmation gate](#confirmation-gate)
- [Reminders](#reminders)
- [Image / video / audio / file handling](#image--video--audio--file-handling)
- [Security](#security)
- [Operating costs](#operating-costs)
- [Common pitfalls](#common-pitfalls-real-ones-from-this-buildout)
- [Manual smoke tests](#manual-smoke-tests)
- [Adding new capabilities](#adding-new-capabilities)
- [Project structure](#project-structure)

---

## What it does

| User says (in LINE) | Bot does |
|---|---|
| "hi" / "help" / "what can you do" | Greets / lists every capability |
| `set my timezone to Asia/Bangkok` | Stores. Used in calendar drafts, briefings, reminders |
| `remember I prefer espresso over filter` | Durable fact. Future replies factor it in |
| `forget memory #3` / `edit memory #2 to say…` | Memory editor |
| `add a task to ship the cert` / `list my tasks` / `mark task #3 done` | Persistent open work items (distinct from reminders) |
| `remind me in 5 min to stretch` | One-shot QStash push |
| `remind me every weekday at 8am to take vitamins` | Recurring schedule |
| `email mom the receipt` | Looks up "mom" in your Google Contacts → drafts → YES → sent |
| `email panupolt + jamyang cc grandmatits` | Multi-recipient single draft |
| `summarize today's inbox` / `what's in my unread emails` | gmail_summarize_recent |
| `reply to bob's last email saying I'll be there` | gmail_search → draft_gmail_reply (proper threading) |
| `send this on Monday at 9 AM` | Scheduled email (QStash-deferred) |
| `schedule lunch with Ana tomorrow at noon` | Google Calendar draft + create |
| `what's on my calendar today` | list_upcoming_events |
| `search my drive for the q3 deck` | Drive search |
| `read me my Q3 deck` (after search) | Plain-text content (auto-converts Google Docs) |
| Sends a PDF + `save this to my drive` | Drive upload from staged LINE media |
| Sends a PDF + `email this to bob@x.com` | Real attachment, not a link |
| Sends 4 photos + `send all of them to my wife` | 4 attachments in one email |
| Sends a photo + `extract text` | OCR via Gemini multimodal |
| Sends a voice memo + `transcribe this` | Audio → text |
| Sends a PDF + `summarize this document` | Bullet-point summary |
| `use my work google account from now on` | switch_google_account |
| `connect another google account` | OAuth flow for a second account |
| `send me a daily briefing at 7am` | Enables proactive morning push (calendar + tasks + optional inbox) |
| `remind me 15 min before each meeting` | Pre-meeting alerts via cron sweep |
| `what did I send to bob today` | sent_history audit lookup |
| `search my old conversations for X` | search_archived_memory (months back) |
| `export my data` | JSON dump |

---

## Quickstart from zero

```bash
# 1. Install
npm install

# 2. Get your dev env vars from Vercel (after the project is set up — see SETUP.md)
npx vercel env pull .env.local

# 3. Run
npm run dev
# Use ngrok or similar to tunnel a public HTTPS URL to localhost:3000
# Set the LINE webhook URL to https://<tunnel>/api/line/webhook for local testing.
```

For first-time provisioning (Google Cloud, LINE channel, Vercel + Marketplace integrations, env vars), see **[SETUP.md](./SETUP.md)**. It's the click-by-click console walkthrough.

For internals you need when modifying the code, see **[CLAUDE.md](./CLAUDE.md)**.

---

## Architecture

```
┌─────────┐  HTTPS POST   ┌────────────────────────────────────────────┐
│  LINE   │──────────────▶│ /api/line/webhook  (Next.js route)         │
└─────────┘   (signed)    │  1. Verify X-Line-Signature                │
                          │  2. Return 200 immediately (avoid retries) │
                          │  3. after(async () => processEvents())     │
                          └────────────────────────────────────────────┘
                                          │
                                          ▼
              ┌────────────────────────────────────────────────┐
              │ For each event (text / image / video / audio / │
              │ file / sticker / follow):                      │
              │  • dedup by webhookEventId                     │
              │  • per-user rate-limit (Upstash sliding 30/hr) │
              │  • if pending action queue not empty:          │
              │     classify YES/NO → execute or discard       │
              │  • else: respond via the agent                 │
              │  • staged-media bookkeeping for attachable     │
              │    files                                       │
              │  • every 10th turn → background fact extract   │
              └────────────────────────────────────────────────┘
                                          │
                                          ▼
        ┌────────────────────────────────────────────────────────────┐
        │ runAgent(): generateText() with                            │
        │   model:    gemini-flash-latest (via @ai-sdk/google)       │
        │   system:   personality + memory + accounts + staged media │
        │   tools:    13 tools, gated on env (Google/QStash/Tavily)  │
        │   stopWhen: stepCountIs(8)                                 │
        │   safety:   HARM_CATEGORY_* = BLOCK_NONE                   │
        │                                                            │
        │ Post-process result.steps:                                 │
        │   • detect need_google_auth → override reply with link     │
        │   • detect google_api_disabled → override with enable URL  │
        │   • detect google_error → surface message + status         │
        │   • detect rate-limit (RESOURCE_EXHAUSTED) → friendly wait │
        │   • render canonical draft block from tool args            │
        │     (NOT the model's paraphrase)                           │
        └────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                           Reply via LINE replyToken (or push)
                           Append turn to rolling history
```

**Why "after(async) immediately + push"?** LINE webhooks must respond within ~5 seconds or get retried. Real work (Gemini calls, Drive fetches, Gmail sends) can take longer. `after()` lets us 200 right away and continue on the same Function instance.

**Why a pending-action queue?** A single user message often triggers multiple actions in one turn ("email these people AND schedule a meeting"). The model emits both `draft_email` and `draft_calendar_event` in one parallel-tool-use step. Both `appendPending` calls happen concurrently, so the queue uses atomic `RPUSH` to avoid races. One YES → entire queue executes in order.

**Why canonical draft rendering?** LLMs paraphrase. We don't want the user to confirm "an email about the certificate" only to have the bot send something different than what was actually drafted. After `generateText`, we inspect `result.steps` for tool calls, build a verbatim draft block from the actual tool-call inputs, and append (or replace) the model's text. Source of truth = tool args.

---

## Tools the bot has

40+ tools across 12 categories. The model picks them based on description text.

### Help / Settings
| Tool | What it does |
|---|---|
| `show_help` | Concise capabilities dump (also covers /help, "what can you do") |
| `get_my_settings` | Show user's tz / location / language / briefing prefs |
| `set_timezone` | IANA tz (e.g. "Asia/Bangkok") |
| `set_location` | Free-text location label |
| `set_language` | Pin reply language (or null = auto-match) |
| `enable_morning_briefing` | Daily push at HH:mm local; opt-in inbox digest |
| `disable_morning_briefing` | |
| `enable_pre_meeting_alerts` | Push N min before each calendar event |

### Memory (short-term + long-term)
| Tool | What it does |
|---|---|
| `remember` | Add a durable fact |
| `list_memories` | Show all stored facts (1-indexed) |
| `update_memory` | Replace a fact at index N |
| `forget_memory` | Delete a fact at index N |
| `clear_all_memories` | Wipe all (destructive) |
| `search_archived_memory` | Search compressed summaries of conversations beyond the rolling 20-turn window |
| `list_archived_memory` | List all archived chunks |

### Tasks (persistent open items)
| Tool | What it does |
|---|---|
| `add_task` | New task with optional due date |
| `list_tasks` | Filter open / done / all |
| `complete_task` / `reopen_task` | Toggle |
| `update_task` | Edit title/notes/dueAt |
| `delete_task` | Hard delete |

### Reminders (one-shot + recurring)
| Tool | What it does |
|---|---|
| `set_reminder` | Future LINE push via QStash (one-shot) |
| `set_recurring_reminder` | Cron schedule (daily / weekdays / weekends at HH:mm local) |
| `list_reminders` | All pending |
| `cancel_reminder` | By id (works for both one-shot and recurring) |

### Web
| Tool | What it does |
|---|---|
| `web_search` | Tavily query (free 1000/mo) |

### Google account management
| Tool | What it does |
|---|---|
| `list_google_accounts` | All connected accounts + which is active |
| `connect_google_account` | Returns a 10-min signed connect link (also auto-issued by other tools when needed) |
| `switch_google_account` | Set active account by email |
| `disconnect_google_account` | Wipe one account's tokens |

### Contacts (gated by Google OAuth)
| Tool | What it does |
|---|---|
| `contacts_search` | Resolve "mom"/"bob" → email + phone via Google People API + "Other contacts" fallback |

### Email — outbound (gated by Google OAuth)
| Tool | What it does |
|---|---|
| `draft_email` | Compose; queues for YES; multi-recipient + cc/bcc + Drive attachments + LINE-media attachments |
| `schedule_email` | Defer the send to a specific future ISO time |
| `list_scheduled_emails` | View scheduled queue |
| `cancel_scheduled_email` | Cancel by id |

### Email — inbox (gated by Google OAuth, gmail.readonly)
| Tool | What it does |
|---|---|
| `gmail_search` | Gmail query syntax (`from:bob is:unread newer_than:7d`) |
| `gmail_read` | Full plain-text body of one message |
| `gmail_summarize_recent` | Last N hours, optional unread-only |
| `draft_gmail_reply` | Reply to an existing thread (proper In-Reply-To + References headers + Gmail threadId) |

### Calendar (gated by Google OAuth)
| Tool | What it does |
|---|---|
| `draft_calendar_event` | Compose; queues for YES; attendees + location |
| `list_upcoming_events` | Read-only peek (also used by morning briefing) |

### Drive (gated by Google OAuth)
| Tool | What it does |
|---|---|
| `drive_search` | Full-text + name search |
| `drive_list_recent` | Recently modified files |
| `drive_get_link` | Share link by file id |
| `drive_read_text` | Plain text contents (auto-converts Google Docs) |
| `drive_upload_recent_media` | Save staged LINE files (image/video/audio/file) into Drive (optional folder) |

### Media AI (Gemini multimodal on staged LINE files)
| Tool | What it does |
|---|---|
| `transcribe_audio` | Voice memo → text (verbatim) |
| `summarize_audio` | Voice memo → 2–4 sentence summary |
| `ocr_image` | Read all text in a photo (receipts, signs, screenshots, handwriting) |
| `summarize_image` | Describe scene / objects / action items |
| `summarize_document` | Bullet summary of a PDF (or other staged document) |

### Staged media
| Tool | What it does |
|---|---|
| `list_staged_media` | What LINE files the bot has staged, 1-indexed |
| `clear_staged_media` | Discard all staged files |

### History / export
| Tool | What it does |
|---|---|
| `sent_history` | Look up emails / events / reminders the bot already sent on the user's behalf (filter by kind, time window, recipient) |
| `export_my_data` | JSON dump of everything stored about the user (settings, facts, history, archive, tasks, sent log) |

---

## Memory model

Five layers, all keyed by LINE `userId`:

1. **Profile** (`user:{userId}:profile`) — `{ displayName, joinedAt }`.
2. **Settings** (`user:{userId}:settings`) — `{ timezone, location, language, morningBriefingTime, preMeetingMinutes, … }`. Injected into every system prompt.
3. **Rolling history** (`user:{userId}:history`) — last 20 turns. Fed verbatim every turn.
4. **Extracted facts** (`user:{userId}:facts`) — durable bullets, capped ~4KB. Every 10th turn, an extractor LLM call updates them. User can also `remember` / `update_memory` / `forget_memory` directly.
5. **Long-term archive** (`user:{userId}:archive`) — every 10 turns, the same extractor pass also writes a 2–4 sentence chunk summary. Capped at 200 chunks (~years of conversation). Searchable via `search_archived_memory`. Cheap substring match — good enough at personal-bot scale.

The user can also explicitly invoke `remember` to write a fact directly.

System prompt every turn includes:
- Base personality + capability list
- User's display name + stored location + preferred language
- Current UTC time + user's local time in their stored timezone — so the model can resolve "in 5 minutes" / "tomorrow at 3pm" correctly
- Connected Google accounts (with active marked)
- Staged LINE media (with index, type, filename, size)
- All extracted facts as bullets

---

## Multi-account Google support

Many people have a personal + work Gmail. Lekha handles both:

**Storage:**
- `google:accounts:{userId}` → `{ accounts: [{email, addedAt}], activeEmail }`
- `google:tokens:{userId}:{email}` → AES-256-GCM-encrypted refresh+access tokens

**Flow:**
1. First `draft_email` → throws `GoogleAuthRequired` → bot returns connect link.
2. User taps → signs in as `personal@gmail.com` → bot stores tokens, marks active.
3. Later: "use my work account" → `switch_google_account` → next email sends from work.
4. "connect my work account too" → `connect_google_account` returns another link, signs in as `work@x.com`, stored alongside, marked active.
5. Tools (`draft_email`, `draft_calendar_event`, `drive_*`) accept optional `fromEmail` param to pin a specific account per-call without changing default.

**Auto-resume after OAuth:** If you triggered the connect link by trying to do something (e.g., send an email), the OAuth callback executes the pending action immediately and pushes the result to LINE. No "try again" round-trip.

---

## Attachment system

Three sources of attachments, freely mixable in one email:

### A. Drive files
```
attachments: [
  { fileId: "1abc..." },
  { fileId: "2xyz...", fromEmail: "work@x.com" }
]
```
- Find file IDs via `drive_search` first.
- Per-attachment `fromEmail` lets you mix Drive files from different connected accounts in one email.
- Google-native files auto-export: Docs → PDF, Sheets → xlsx, Slides → pptx.

### B. LINE-staged media (multi-file batching)

Anything the user sends to the bot via LINE — image, video, audio, file (PDF, docx, anything) — is staged for attachment.

**Staging:**
- Store: `recent_media:{userId}` Redis list, `RPUSH` per item, capped at 10 (LTRIM), TTL 30 min.
- We don't cache the bytes — just the LINE messageId + content-type + filename + size + duration. Bytes are pulled from LINE at send time.
- Each new file appends to the queue (doesn't replace).

**Attaching:**
```
attach_recent_media: true                  // attach ALL staged
// OR
attach_recent_media_indexes: [1, 3]        // 1-indexed cherry-pick from oldest
// optional, aligned with the indexes (or all staged when attach_recent_media=true):
attach_recent_media_filenames: ["resume_v2.pdf", ""]   // empty string = keep default
```

**After successful send,** the staged list is cleared (so you don't accidentally re-attach the same files in the next email). If you want to keep them, send a fresh copy.

**System prompt** tells the model exactly what's staged each turn:
```
LINE files staged for attachment (1-indexed, oldest first):
1. file "CompTIA Network+ ce certificate.pdf" (application/pdf, 412 KB) — 2m ago
2. image (image/jpeg, 380 KB) — 1m ago
3. video "demo.mp4" (video/mp4, 8400 KB) — 0m ago
```

### C. Mixing
A single `draft_email` can have Drive files **and** staged LINE files **and** an arbitrary multi-recipient `to`/`cc`/`bcc`. They all become real RFC-2822 multipart MIME attachments — recipients see the actual files in their inbox, not links.

---

## Proactive layer

The bot doesn't only react — it initiates. Powered by a single QStash schedule that POSTs `/api/cron/sweep` every 15 minutes:

- **Daily morning briefing**: per-user enable via `enable_morning_briefing`. At the user's chosen local time, the sweep builds a digest from today's calendar + open tasks + (optional) unread Gmail, lightly polished by Gemini, pushed to LINE.
- **Pre-meeting alerts**: per-user enable via `enable_pre_meeting_alerts`. The sweep checks each user's calendar for events starting within their lead-window and pushes a heads-up. Idempotent per event (`premeet:{userId}:{eventId}` keys, 6h TTL).
- **Scheduled emails**: separate QStash one-shot per email. When fired, sends and pushes confirmation to LINE.
- **Recurring reminders**: separate QStash schedule per reminder. Cron is computed from user's local-time HH:mm via `localTimeToUtcCron`.

User registration: every webhook event calls `registerUser(userId)` so the sweep can enumerate. No global state needed beyond the `users:active` set.

Setup: see SETUP.md step 11. One QStash schedule with cron `*/15 * * * *` pointing at `/api/cron/sweep`. Without it the rest of the bot still works — you just don't get morning briefings or pre-meeting alerts.

## Confirmation gate

Anything externally visible (sending email, creating a calendar event) is **drafted, queued, and gated behind YES**:

1. Model calls `draft_email` and/or `draft_calendar_event`.
2. Each call writes to `pending:{userId}` Redis list (atomic `RPUSH`, TTL 5 min).
3. Orchestrator post-processes: builds canonical verbatim draft block from tool args (subject, body, recipients, attachments, ISO times rendered in Bangkok TZ).
4. User replies `YES` (or `yes` / `ok` / `send` / `ใช่` / `ส่ง` / a couple dozen variants) → orchestrator runs `executePendingAll`, executes every queued action in order, returns one result line per action.
5. User replies `NO` (or `cancel` / `ไม่`) → queue cleared, "Cancelled."
6. User replies anything else → queue cleared, model handles the new instruction (with the previous draft as context).

Reminders are NOT gated — `set_reminder` schedules immediately. If you want to cancel, `list_reminders` then `cancel_reminder <id>`.

---

## Reminders

Powered by [Upstash QStash](https://upstash.com/docs/qstash):

1. `set_reminder({when: ISO, message})` → publishes a delayed HTTP POST to `/api/reminders/fire`.
2. Stored in Redis with `qstashId` so user can `cancel_reminder`.
3. At fire time, QStash POSTs (with HMAC signature) → fire route verifies → sends a LINE push: `⏰ Reminder: <message>`.
4. Reminder is removed from Redis after firing.

No cron polling. No in-memory timers (which would die with serverless cold starts). Up to a year ahead.

---

## Image / video / audio / file handling

LINE delivers four binary content types over the same `/v2/bot/message/{id}/content` endpoint:

| LINE message type | What the bot does |
|---|---|
| `image` | Fetches bytes, passes to Gemini multimodal as image part (vision Q&A), AND stages for attachment |
| `video` | Stages for attachment, fetches just one byte to determine actual content-type |
| `audio` | Stages for attachment, same probe trick for content-type |
| `file` | Stages for attachment with the LINE-provided filename + size preserved |

In all four cases the model gets text in its prompt explaining the staged item (kind, mime, filename, size, time-since-sent), and the user's text caption (if any) flows through the agent loop normally. So you can do "send these to bob" in the same message as the file, OR send the file first and the instruction in a follow-up — both work.

---

## Security

| Concern | Defense |
|---|---|
| LINE webhook spoofing | HMAC-SHA256 verification of `X-Line-Signature` against raw body, timing-safe compare, BEFORE any work |
| QStash callback spoofing | `Upstash-Signature` verified via `@upstash/qstash` Receiver |
| OAuth state CSRF / replay | Signed (HMAC) connect-link tokens, server-side nonce in Redis with 10-min TTL, single-use |
| Refresh tokens at rest | AES-256-GCM with `TOKEN_ENCRYPTION_KEY` (32 bytes) |
| LLM jailbreaking the user's identity | `userId` is bound from the verified webhook, never from tool args. Tools that send things use that bound `userId` to fetch tokens — bot can never send as a user who didn't authorize |
| Free quota burn | Per-user sliding-window rate limit (30/hr) via `@upstash/ratelimit` |
| Webhook replay | Each event de-duped by `webhookEventId` for 10 min |
| Confirmation gate | Drafts are queued, executed only on explicit YES — bot won't send the wrong email even if it misreads your intent |

---

## Operating costs

For a single personal user (~50 messages/day, mixed text + images + occasional Drive/email):

| Service | Plan | Approx monthly |
|---|---|---|
| Vercel | Hobby | $0 |
| Upstash Redis | Free tier (10K commands/day) | $0 |
| Upstash QStash | Free tier (500 messages/day) | $0 |
| Tavily | Free tier (1000 searches/mo) | $0 |
| Gemini API | Free tier OR pay-as-you-go | $0 (free) or ~$1–3 (paid, no rate-limit pain) |
| LINE Messaging API | Free 200 push messages/mo | $0 (replies are unlimited; pushes only count when bot pushes you, e.g., reminders) |

If you outgrow the Gemini free tier (you will if you're chatty — the agent burns 2–4 calls per turn), enable billing on the Gemini key. **Don't enable billing on Google Cloud just for Drive/Gmail/Calendar APIs** — those are free regardless. Gemini billing is independent.

---

## Common pitfalls (real ones from this buildout)

1. **Gemini free tier is 10–30 RPM.** Multi-tool agentic turns hit this. The agent now catches `RESOURCE_EXHAUSTED` and replies "out of free quota for ~30s, try again". Pay $1/mo for billing if you want it gone.
2. **`HARM_CATEGORY_*` thresholds**: use `BLOCK_NONE`, not `OFF`. `OFF` is rejected by some Gemini variants. Skip `CIVIC_INTEGRITY` — not all models accept it.
3. **Vercel Marketplace's Upstash Redis injects `KV_*` env vars**, not `UPSTASH_REDIS_REST_*`. The env loader accepts both.
4. **OAuth refresh tokens are tied to the OAuth client_id that issued them.** Swap projects → old tokens fail with `invalid_grant`. The bot detects this and surfaces a connect link.
5. **Google Cloud projects belong to the account that created them.** Switch to the right account in the Cloud Console (top-right avatar) — don't request the `Project Mover` role offered on the access-denied page (that's the wrong role anyway).
6. **Each Google API must be enabled separately** in `APIs & Services → Library`. Drive ≠ Gmail ≠ Calendar.
7. **OAuth consent screen "Testing" mode** restricts to listed test users. Add every Gmail you'll OAuth into.
8. **Don't paste secrets in chat.** They live in transcripts forever. Use `vercel env add` (interactive prompt, never echoed). Rotate any that leaked.
9. **Tool exceptions don't bubble to the orchestrator** — AI SDK v6 catches them and feeds the error to the model. For control-flow ("auth required", "API disabled", "quota"), tools must RETURN a structured marker; orchestrator scans `result.steps` post-hoc and overrides the model's reply. See `lib/tools/with-google.ts`.
10. **Parallel tool calls in one step race.** Two `setPending` calls overwrote each other before — switched to atomic `RPUSH`. Same for `recent-media` staging.
11. **Calendar event htmlLinks require being signed into the calendar's account.** "Could not find the requested event" on click usually means wrong account in the browser. The bot now appends a hint with the right email.
12. **LINE replyToken expires in ~1 minute and is single-use.** After OAuth/long async work, switch to push messages.

---

## Manual smoke tests

After any meaningful deploy, run through these from your phone:

| Test | Expected |
|---|---|
| `hi` | Greeting reply |
| `remember I prefer espresso` | "Got it." Future replies factor it in |
| `list my memories` | Shows the espresso fact |
| `remind me in 2 minutes to drink water` | Confirmation, then `⏰ Reminder` push 2 min later |
| `what's the weather in Tokyo` | Web search fires, gives a real answer |
| Send a photo of food | Bot describes it |
| Photo + `email this to bob@x.com` | Draft with the .jpg attached, YES → sent |
| 3 photos in a row + `send all of them to bob` | Single email with 3 attachments after YES |
| `send mom@x.com an email about my new job` | Draft (verbatim subject + body shown), YES → sent from your active Gmail |
| `add lunch with Ana tomorrow at noon` | Calendar draft (Bangkok TZ shown), YES → event created, link returned with account hint |
| `connect another google account` | Returns connect link; OAuth as second account; `list my google accounts` shows both |
| `use my work account` | Switches active |
| `search my drive for "q3"` | Returns real Drive files |
| Send a 50MB file | Stages; subsequent email attaches the actual file |
| Spam 50 messages in a minute | Rate limit kicks in cleanly: "give me a sec, try again in ~Xs" |
| Try the connect link with one char tampered | 400 / "Link expired" |

To watch logs in real time during testing:
```bash
npx vercel logs lekha-iota.vercel.app
```
Look for `[webhook]`, `[agent]`, `[reminder]`, `[oauth]`, `[google]`, `[send]` prefixes.

---

## Adding new capabilities

### A new tool
1. Create `lib/tools/your-tool.ts`. Export `buildYourTools(userId)` returning a record of `tool({ description, inputSchema, execute })`.
2. Wrap any Google API call in `withGoogleClient(userId, fromEmail, [scopes], async ({client}) => …)` — gives you free auth-required + api-not-enabled handling.
3. Register in `lib/tools/index.ts`, gated on env if it depends on a service.
4. If the tool produces something the user must approve, write through `appendPending(userId, action)` and add a renderer case in `lib/llm/render-drafts.ts`.
5. Update `lib/llm/prompts.ts` so the model knows the tool exists.
6. Restart `npm run dev` and try it.

### A new LLM provider
Edit `lib/llm/provider.ts`. Just `chatModel()` and `extractorModel()`. Could be `@ai-sdk/anthropic`, `@ai-sdk/openai`, the Vercel AI Gateway, etc.

### A new pending-action type
1. Add a variant to `PendingAction` in `lib/confirm.ts`.
2. Add a case in `executeOne` inside `lib/pending-runner.ts`.
3. Render it in `lib/llm/render-drafts.ts`.

---

## Project structure

```
app/
├── api/
│   ├── line/webhook/route.ts          # main orchestrator
│   ├── oauth/google/callback/route.ts # OAuth callback + auto-resume
│   ├── reminders/fire/route.ts        # QStash callback
│   └── health/route.ts
├── connect/[token]/page.tsx           # OAuth landing
└── layout.tsx, page.tsx
lib/
├── env.ts                             # zod env + redisCreds()
├── errors.ts                          # GoogleAuthRequired, RateLimited, NeedsConfirmation
├── ratelimit.ts                       # 30/hr/user
├── confirm.ts                         # pending action queue (RPUSH)
├── pending-runner.ts                  # executePendingAll
├── line/{verify, client, types}.ts
├── llm/{provider, prompts, extract-facts, render-drafts}.ts
├── memory/{redis, crypto, history, facts, profile, recent-media}.ts
└── tools/
    ├── index.ts                       # toolsForUser(userId)
    ├── google-auth.ts                 # multi-account OAuth + encrypted tokens
    ├── with-google.ts                 # auth/api/quota error → structured marker
    ├── google-accounts.ts             # list/connect/switch/disconnect
    ├── reminders.ts                   # set/list/cancel via QStash
    ├── email.ts                       # draft + sendEmail (multi-recip + Drive + LINE attachments)
    ├── calendar.ts                    # draft + create + list_upcoming
    ├── drive.ts                       # search + recent + link + read
    ├── web-search.ts                  # Tavily
    ├── memory.ts                      # remember + list_memories
    └── staged-media.ts                # list + clear staged LINE media
```

---

## License & contribution

Personal project. No license, no formal contribution flow. Fork freely.

If you find a real bug while using it (or want a new capability), open an issue or PR. The code is small enough to make targeted changes safely; CLAUDE.md has the architectural conventions.
