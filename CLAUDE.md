# Lekha — repo guide for Claude Code

A personal AI assistant living in LINE. Public bot, per-user state, agentic tool use.

## Stack at a glance

| | |
|---|---|
| Runtime | Next.js 16 App Router on Vercel Functions (Node.js, Fluid Compute) |
| Language | TypeScript, strict, `noUncheckedIndexedAccess` on |
| LLM | Vercel AI SDK v6 + `@ai-sdk/google` (`gemini-flash-latest` + `gemini-flash-lite-latest`) |
| Memory / queues | Upstash Redis (Marketplace integration → `KV_*` env vars) |
| Scheduled jobs | Upstash QStash (delayed HTTP callbacks for reminders) |
| Web search | Tavily |
| Google APIs | `googleapis` SDK — Gmail send, Calendar events, Drive |
| Validation | Zod |

## Quick commands

```bash
npm run dev          # next dev (needs .env.local; pull with `vercel env pull`)
npm run build        # production build (turbopack)
npm run typecheck    # tsc --noEmit
npx vercel deploy --prod --yes   # ship
npx vercel logs lekha-iota.vercel.app   # tail prod logs (forward-only stream)
```

## Project layout

```
app/
├── api/
│   ├── line/webhook/route.ts          # main orchestrator — verify, dispatch, agent loop
│   ├── oauth/google/callback/route.ts # OAuth code exchange + auto-resume pending action
│   ├── reminders/fire/route.ts        # QStash callback → LINE push
│   └── health/route.ts
├── connect/[token]/page.tsx           # signed-token landing → Google consent redirect
├── layout.tsx, page.tsx               # minimal shell
lib/
├── env.ts                             # zod env validation + redisCreds() helper (handles KV_* and UPSTASH_REDIS_REST_*)
├── errors.ts                          # GoogleAuthRequired, RateLimited, NeedsConfirmation
├── ratelimit.ts                       # Upstash sliding-window (30/hr/user)
├── confirm.ts                         # pending action queue (RPUSH, atomic; yes/no classifier)
├── pending-runner.ts                  # executePendingAll — runs the whole queue on YES
├── line/
│   ├── verify.ts                      # X-Line-Signature HMAC (timing-safe)
│   ├── client.ts                      # reply, push, showLoading, getMessageContent, getProfile
│   └── types.ts                       # zod schemas for webhook payloads (text, image, video, audio, file, sticker)
├── llm/
│   ├── provider.ts                    # chatModel() + extractorModel() — swap here to change LLMs
│   ├── prompts.ts                     # base personality + system prompt builder + fact-extraction prompt
│   ├── extract-facts.ts               # background fact-extraction (every 10th turn)
│   └── render-drafts.ts               # canonical verbatim draft block (overrides model paraphrasing)
├── memory/
│   ├── redis.ts                       # singleton Upstash client
│   ├── crypto.ts                      # AES-256-GCM (for OAuth tokens at rest) + HMAC for signed links
│   ├── history.ts                     # rolling 20-message history (LPUSH+LTRIM)
│   ├── facts.ts                       # extracted user-facts blob (capped ~4KB)
│   ├── profile.ts                     # display name + first-contact tracking
│   └── recent-media.ts                # staged LINE media list (RPUSH, capped 10, TTL 30 min)
├── tools/
│   ├── index.ts                       # toolsForUser(userId) — registry, gated on env
│   ├── google-auth.ts                 # multi-account OAuth, encrypted token storage, scope check
│   ├── with-google.ts                 # withGoogleClient wrapper — catches auth/api/quota errors → structured marker
│   ├── google-accounts.ts             # list/connect/switch/disconnect_google_account
│   ├── reminders.ts                   # set/list/cancel via QStash
│   ├── email.ts                       # draft_email + sendEmail (multi-recipient, Drive + LINE-media attachments)
│   ├── calendar.ts                    # draft_calendar_event + list_upcoming_events + createCalendarEvent
│   ├── drive.ts                       # search/list_recent/get_link/read_text
│   ├── web-search.ts                  # Tavily
│   ├── memory.ts                      # remember / list_memories
│   └── staged-media.ts                # list_staged_media / clear_staged_media
```

## Key architectural decisions (do NOT undo without thinking)

### 1. Tool errors are returned, not thrown
The AI SDK v6 catches exceptions in `tool({ execute })` and feeds the error back to the model as a tool result, which the model then paraphrases (badly). For control-flow errors that the orchestrator MUST react to (Google auth required, API not enabled, generic Google API failures), use `withGoogleClient()` which returns a structured `{ ok: false, need_google_auth | google_api_disabled | google_error, … }` object. The orchestrator scans tool results post-hoc in `runAgent` and overrides the model's reply when these markers are present.

### 2. Pending actions are an atomic queue
`appendPending` uses `RPUSH` because the model often calls `draft_email` AND `draft_calendar_event` in a single parallel-tool-use step. Read-modify-write would race (last write wins, one action lost). Same for `recent-media` staging — also `RPUSH` capped via `LTRIM`.

### 3. Canonical draft rendering, not model paraphrasing
After `generateText` returns, `runAgent` collects all `draft_email` / `draft_calendar_event` tool calls and builds a verbatim block via `renderDraftsBlock`. This is appended (or replaces) the model's text reply. The user always sees the actual subject/body/recipients, not a summary.

### 4. Auto-resume after OAuth
The `/api/oauth/google/callback` route, after a successful token exchange, checks for a pending action and executes it immediately, then pushes the result to LINE. No "try again" round-trip.

### 5. Per-user multi-account Google
Tokens are keyed `google:tokens:{userId}:{email}`, with an `accounts` blob at `google:accounts:{userId}` tracking which is active. `getGoogleClient(userId, email?, requiredScopes?)` returns the client for the active account by default; tools accept an optional `fromEmail` to override.

### 6. Per-user state isolation
Everything in Redis is keyed by LINE `userId`. There is no global state besides the env. Adding a tool? Per-user-bind it via `buildXxxTools(userId)`.

### 7. Webhook responds 200 immediately
The handler uses `after(async () => …)` so LINE doesn't time out / retry. All real work happens after the response. Webhook events are de-duped via `seen:{webhookEventId}` keys with 10-min TTL.

### 8. Webhook signature verify before any work
`verifyLineSignature` runs first, on the raw body, before JSON parsing. Same for QStash signatures on the reminders/fire route.

### 9. Tokens encrypted at rest
OAuth tokens are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` (32-byte hex). `OAUTH_STATE_SECRET` HMACs the connect-link tokens.

### 10. Rate limit per user
Upstash sliding window, 30/hr/user. Protects free Gemini quota and LINE push quota.

## Conventions

- **No comments unless explaining a non-obvious WHY.** Don't restate what the code does. Reference for surprising decisions only (e.g. "use RPUSH because parallel tool calls race").
- **Strict TS, `noUncheckedIndexedAccess`.** Array element access returns `T | undefined` — handle accordingly. Tuple/array destructuring of fixed-length `as [string, string, string]` is acceptable when origin is bounded (e.g. `string.split(".")` checked for length).
- **Zod for everything at boundaries.** Webhook payloads, tool inputs, env. Internal types are plain TS.
- **Prefer `lib/` for pure logic, `app/api/*/route.ts` for HTTP boundaries.** Don't export non-handler functions from route files (Next will warn).
- **No `console.log` in hot paths**, but `console.warn` / `console.error` with a `[module]` prefix (e.g. `[reminder]`, `[oauth]`) are good — they show up in Vercel runtime logs.

## Adding a new tool

1. New file in `lib/tools/your-tool.ts`. Export `buildYourTools(userId)` returning a record of `tool({ description, inputSchema, execute })`.
2. Wrap any Google call in `withGoogleClient(userId, fromEmail, [scopes], async ({client}) => …)` — this gives you free auth-required + api-not-enabled handling.
3. Register in `lib/tools/index.ts`, gated on env if it depends on a service.
4. If it produces something the user must approve (like a draft), use `appendPending` and add a renderer in `lib/llm/render-drafts.ts`.

## Swapping the LLM

Edit `lib/llm/provider.ts` only. `chatModel()` returns the model handle used by `runAgent`. Currently `gemini-flash-latest` (free tier, multimodal). To swap to a Vercel AI Gateway provider string: `import { gateway } from "ai"` and return `gateway("anthropic/claude-sonnet-4-6")`.

## Gotchas (lessons learned)

- **Gemini free tier is 10–30 RPM** depending on the model. An agentic turn burns 2–4 calls. Multi-step turns + the SDK's auto-retry loop will hit 429s. The `parseQuotaError` path returns a clean retry-after to the user.
- **`gemini-flash-latest` alias** rotates to whichever flash variant currently has the highest free quota. Stick with it unless you have a reason.
- **HARM_CATEGORY thresholds**: use `BLOCK_NONE`, not `OFF`. `OFF` is rejected on some Gemini variants. `CIVIC_INTEGRITY` may not be a valid category for all models — omit it.
- **Vercel Marketplace's Upstash Redis injects `KV_*` env names**, not `UPSTASH_REDIS_REST_*`. `redisCreds()` in `lib/env.ts` accepts both.
- **OAuth refresh tokens are tied to the client_id that issued them.** When you swap the OAuth client (e.g., move projects), old tokens fail with `invalid_grant` — `withGoogleClient` detects this string and treats it as need-reauth.
- **Google Cloud projects belong to the account that created them.** A different signed-in account will see a "request access" page for `roles/resourcemanager.projectMover` (which is the wrong role anyway). Switch accounts in the Cloud Console UI; don't request the role.
- **Google Drive API ≠ Gmail API ≠ Calendar API.** Each must be explicitly enabled in `APIs & Services → Library`. Enabling one doesn't enable the others.
- **OAuth consent screen "Testing" mode** restricts sign-in to listed test users. For a pre-production bot, always add every Gmail you'll OAuth into.
- **LINE replies use a one-shot `replyToken` (~1 min TTL)**. After OAuth flows or long-running async work, switch to push messages.
- **Push messages count against the LINE free-tier monthly quota** (200/mo). Fine for personal use, may need a paid LINE plan at scale.
- **LINE doesn't bundle a caption with media messages.** Photo + caption arrives as two separate webhook events. The recent-media staging spans messages within its 30-min TTL.

## Testing manually (can't easily automate yet)

End-to-end smoke from your phone — see README.md "Manual smoke tests" section.

For Vercel-side investigation:
```bash
npx vercel logs lekha-iota.vercel.app   # live stream, ctrl-C to exit
```
Look for `[webhook]`, `[agent]`, `[reminder]`, `[oauth]`, `[google]` prefixes.
