# Lekha — repo guide for Claude Code

A personal AI assistant living in LINE. Public bot, per-user state, agentic tool use, proactive layer.

## Stack at a glance

| | |
|---|---|
| Runtime | Next.js 16 App Router on Vercel Functions (Node.js, Fluid Compute) |
| Language | TypeScript, strict, `noUncheckedIndexedAccess` on |
| LLM | Vercel AI SDK v6 + `@ai-sdk/google` (`gemini-flash-latest` + `gemini-flash-lite-latest`) |
| Memory / queues | Upstash Redis (Marketplace integration → `KV_*` env vars) |
| Scheduled jobs | Upstash QStash (one-shot reminders, deferred emails, recurring schedules, cron sweep) |
| Web search | Tavily |
| Google APIs | `googleapis` SDK — Gmail send/read/modify, Calendar events/readonly, Drive, People (contacts) |
| Validation | Zod |

## Quick commands

```bash
npm run dev          # next dev (needs .env.local; pull via `vercel env pull`)
npm run build        # production build (turbopack)
npm run typecheck    # tsc --noEmit
npx vercel deploy --prod --yes   # ship
npx vercel logs lekha-iota.vercel.app   # tail prod logs (forward-only stream)
```

## Project layout

```
app/
├── api/
│   ├── line/webhook/route.ts          # main orchestrator
│   ├── oauth/google/callback/route.ts # OAuth code exchange + auto-resume pending
│   ├── reminders/fire/route.ts        # QStash callback for one-shot/recurring reminders
│   ├── scheduled-email/fire/route.ts  # QStash callback for deferred email sends
│   ├── cron/sweep/route.ts            # QStash callback every 15 min — proactive layer
│   └── health/route.ts
├── connect/[token]/page.tsx           # signed-token landing → Google consent
└── layout.tsx, page.tsx
lib/
├── env.ts                             # zod env + redisCreds() (KV_* and UPSTASH_REDIS_REST_*)
├── errors.ts                          # GoogleAuthRequired, RateLimited, NeedsConfirmation
├── ratelimit.ts                       # per-user 30/hr sliding window
├── confirm.ts                         # pending action queue (atomic RPUSH)
├── pending-runner.ts                  # executePendingAll — runs queue on YES, logs sends
├── cron.ts                            # QStash schedule helpers + local→UTC cron conversion
├── line/{verify,client,types}.ts      # HMAC, REST client, zod schemas (text/image/video/audio/file/sticker)
├── llm/
│   ├── provider.ts                    # chatModel + extractorModel — swap here for new LLMs
│   ├── prompts.ts                     # base personality + system prompt builder
│   ├── extract-facts.ts               # background fact extraction + archive summarization
│   ├── render-drafts.ts               # canonical verbatim draft block
│   └── briefing.ts                    # builds morning briefing text from calendar/tasks/inbox
├── memory/
│   ├── redis.ts                       # singleton Upstash client
│   ├── crypto.ts                      # AES-256-GCM + HMAC + safeEqual
│   ├── history.ts                     # rolling 20-msg history + turn counter (TTL 90d)
│   ├── facts.ts                       # extracted facts blob + edit/delete/clear
│   ├── archive.ts                     # long-term compressed conversation chunks (200 max)
│   ├── profile.ts                     # display name + first-contact tracking
│   ├── recent-media.ts                # staged LINE media list (RPUSH, 10 max, TTL 30 min)
│   ├── settings.ts                    # per-user tz/locale/loc/briefing prefs
│   ├── tasks.ts                       # persistent open work items
│   ├── sent-log.ts                    # audit log (last 200, 6 month TTL)
│   └── user-registry.ts               # set of all known userIds for cron sweep
└── tools/
    ├── index.ts                       # toolsForUser(userId) — registry, env-gated
    ├── help.ts                        # show_help text dump
    ├── settings.ts                    # set_timezone/location/language/morning_briefing/pre_meeting
    ├── memory.ts                      # remember/list/update/forget/clear + archive search
    ├── tasks.ts                       # CRUD on tasks
    ├── reminders.ts                   # set/list/cancel/set_recurring (one-shot via publish, recurring via schedule)
    ├── web-search.ts                  # Tavily
    ├── contacts.ts                    # contacts_search via Google People API
    ├── google-auth.ts                 # multi-account OAuth, encrypted tokens, scope check, atomic state
    ├── google-accounts.ts             # list/connect/switch/disconnect Google accounts
    ├── with-google.ts                 # auth/api-disabled/quota error → structured marker
    ├── email.ts                       # draft_email + sendEmail (multi-recip, Drive + LINE attach, Gmail threading)
    ├── gmail-inbox.ts                 # gmail_search/read/summarize_recent + draft_gmail_reply
    ├── scheduled-email.ts             # schedule_email/list/cancel — QStash-deferred sends
    ├── calendar.ts                    # draft + create + list_upcoming
    ├── drive.ts                       # search/list_recent/get_link/read_text/upload_recent_media
    ├── media-ai.ts                    # transcribe/summarize_audio + ocr/summarize_image + summarize_document
    ├── sent-history.ts                # query the audit log
    ├── export.ts                      # JSON dump of all user data
    └── staged-media.ts                # list / clear LINE media staged for attach/upload
```

## Key architectural decisions (do NOT undo without thinking)

### 1. Tool errors are RETURNED, not thrown
The AI SDK v6 catches exceptions in `tool({ execute })` and feeds the error back to the model as a tool result, which the model paraphrases (badly). For control-flow that the orchestrator MUST react to (Google auth required, API not enabled, generic API failures), use `withGoogleClient()` which returns structured `{ ok: false, need_google_auth | google_api_disabled | google_error, … }`. The orchestrator scans tool results post-hoc in `runAgent` and OVERRIDES the model's reply.

### 2. Pending actions are an atomic queue
`appendPending` uses `RPUSH` because the model often emits multiple `draft_*` calls in one parallel-tool-use step. Read-modify-write would race (last write wins, one action lost). Same for `recent-media` staging — also `RPUSH` capped via `LTRIM`.

### 3. Canonical draft rendering, not model paraphrasing
After `generateText`, `runAgent` collects all `draft_email` / `draft_calendar_event` tool calls and builds a verbatim block via `renderDraftsBlock`. Source of truth = tool args.

### 4. Auto-resume after OAuth
`/api/oauth/google/callback` executes pending actions immediately after a successful exchange and pushes the result. No "try again."

### 5. Per-user multi-account Google
Tokens at `google:tokens:{userId}:{email}`, accounts blob at `google:accounts:{userId}` with `activeEmail`. `getGoogleClient(userId, email?, requiredScopes?)` → throws GoogleAuthRequired if scopes missing (forces re-consent). Tools accept optional `fromEmail` to override active account per-call.

### 6. Per-user state isolation
Everything in Redis is keyed by LINE `userId`. There is no global state besides env. Adding a tool? Per-user-bind via `buildXxxTools(userId)`.

### 7. Webhook responds 200 immediately
Handler uses `after(async () => …)` so LINE doesn't time out / retry. Real work happens after response. Webhook events de-duped via `seen:{webhookEventId}` 10-min keys.

### 8. Webhook + QStash signature verify before any work
`verifyLineSignature` runs first, on the raw body, before JSON parsing. Same for QStash `Receiver.verify()` on the cron sweep, reminder fire, and scheduled-email fire routes.

### 9. Tokens encrypted at rest
OAuth tokens AES-256-GCM with `TOKEN_ENCRYPTION_KEY` (32-byte hex). `OAUTH_STATE_SECRET` HMACs connect-link tokens. State nonces and connect-link tokens are now atomically consumed via `GETDEL` (single-use).

### 10. Rate limit per user
Upstash sliding window, 30/hr/user. Protects free Gemini quota and LINE push quota.

### 11. Settings injected into every system prompt
Timezone, location, language, connected Google accounts, staged media — all live in the system prompt so the model behaves correctly without needing to call lookup tools.

### 12. Long-term memory via summarization, not vectors
Every fact-extraction cycle (every 10 turns) ALSO writes a 2-4 sentence chunk summary to `archive`. `search_archived_memory` does substring match. Cheap, no vector store needed for personal-bot scale.

### 13. Proactive layer via QStash schedule
`/api/cron/sweep` is hit every 15 min. Iterates `users:active` set, decides per-user whether to push (morning briefing window check, pre-meeting lead-time check). Idempotent per event via `premeet:{userId}:{eventId}` keys.

### 14. Email body is base64-encoded
For Thai/UTF-8 fidelity. `Content-Transfer-Encoding: base64` on the text body part. Some MTAs corrupt non-ASCII under `7bit`.

## Conventions

- **No comments unless explaining a non-obvious WHY.**
- **Strict TS, `noUncheckedIndexedAccess`.** Array element access returns `T | undefined`.
- **Zod for everything at boundaries.**
- **Prefer `lib/` for pure logic, `app/api/*/route.ts` for HTTP boundaries.** Don't export non-handler functions from route files.
- **Logging:** `console.warn` / `console.error` with a `[module]` prefix (`[reminder]`, `[oauth]`, `[google]`, `[sweep]`, `[briefing]`).

## Adding a new tool

1. Create `lib/tools/your-tool.ts`. Export `buildYourTools(userId)` returning `tool({ description, inputSchema, execute })` records.
2. Wrap any Google call in `withGoogleClient(userId, fromEmail, [scopes], async ({client}) => …)`.
3. Register in `lib/tools/index.ts` (env-gated if needed).
4. If it produces something the user must approve, write through `appendPending` and add a renderer in `lib/llm/render-drafts.ts`.
5. Update `lib/llm/prompts.ts` so the model knows about it.

## Adding a new pending-action type
1. Add a variant to `PendingAction` in `lib/confirm.ts`.
2. Add a case in `executeOne` inside `lib/pending-runner.ts` (and `logSent` for the audit trail).
3. Render it in `lib/llm/render-drafts.ts`.

## Swapping the LLM
`lib/llm/provider.ts` only.

## Gotchas (lessons learned the hard way)

- **AI SDK v6 swallows tool exceptions** — must use structured returns for control flow.
- **Parallel tool calls in one step race** — atomic Redis ops mandatory.
- **Gemini free tier 10–30 RPM** — agentic turns burn 2–4 calls; quota error is parsed and surfaced cleanly.
- **`HARM_CATEGORY_*` thresholds**: use `BLOCK_NONE` not `OFF`. Skip `CIVIC_INTEGRITY` (rejected on some variants).
- **Vercel Marketplace's Upstash Redis injects `KV_*`** not `UPSTASH_REDIS_REST_*`.
- **OAuth refresh tokens are tied to client_id** — swap projects → `invalid_grant`. Detected and translated to need-reauth.
- **Google Cloud projects belong to the account that created them.** `roles/resourcemanager.projectMover` is the WRONG role to request from the access-denied page; switch accounts in the Cloud Console UI.
- **OAuth consent screen Testing mode** restricts to listed test users.
- **Each Google API must be enabled separately** — Drive ≠ Gmail ≠ Calendar ≠ People.
- **Calendar event htmlLinks require being signed in as the calendar's account.** "Could not find the requested event" = wrong account in browser.
- **LINE replyToken expires in ~1 minute and is single-use.** Long async work → push.
- **LINE doesn't bundle a caption with media.** Recent-media staging spans messages within 30-min TTL.
- **`Content-Transfer-Encoding: 7bit` is invalid for UTF-8 bodies** (Thai, emoji). Use base64.
- **OAuth state nonce + connect-link token must be atomically consumed** (GETDEL) — non-atomic GET+DEL has a replay window.

## Manual smoke tests
See README.md "Manual smoke tests" — covers settings, tasks, contacts, gmail inbox, OCR/voice/PDF, scheduled email, sent history, briefing.

## Cron sweep setup
The proactive layer needs a QStash schedule pointing at `/api/cron/sweep` every 15 min. See SETUP.md step 11. Without it, morning briefings + pre-meeting alerts are silent (everything else still works).
