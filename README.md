# Lekha

A personal AI assistant that lives in [LINE](https://line.me). Each user who adds the bot gets their own:

- **Memory** that grows over time (rolling chat history + extracted facts).
- **Reminders** scheduled durably (no cron polling).
- **Email** sent from their own Gmail (after OAuth).
- **Calendar** events on their own Google Calendar.
- **Web search** for fresh info.
- **Image understanding** — they can send a photo and ask about it.

Built on Next.js 16 + Vercel AI SDK v6, deployed on Vercel Functions. Gemini 2.5 Flash for the LLM today; the provider abstraction is one line to swap.

## Getting started

See [SETUP.md](./SETUP.md) for the full one-time setup walkthrough.

```bash
npm install
cp .env.example .env.local   # fill in
npm run dev
```

## Architecture sketch

```
LINE → POST /api/line/webhook
  ├── verify HMAC signature
  ├── 200 OK immediately (Vercel `after()` for the real work)
  └── per event:
      ├── rate-limit (Upstash Ratelimit, 30/hr/user)
      ├── load history + facts from Upstash Redis
      ├── if a pending action awaits → classify yes/no, execute or discard
      ├── otherwise → AI SDK generateText with tools registry
      │   ├── reminders   (Upstash QStash)
      │   ├── web_search  (Tavily)
      │   ├── remember    (durable user facts)
      │   ├── draft_email (Gmail OAuth, confirm-gated)
      │   └── draft_calendar_event (Calendar OAuth, confirm-gated)
      ├── reply via LINE replyToken (or push if expired)
      ├── append turn to history
      └── every 10th turn → background fact extraction → merge into memory
```

## Security

- LINE webhook signature verified before any work.
- QStash callback signature verified.
- OAuth state is signed (HMAC) + nonce-stored in Redis with 10-min TTL.
- Refresh tokens encrypted at rest (AES-256-GCM, 32-byte key from env).
- Per-user rate limit. Webhook event de-duplicated by `webhookEventId`.
- Email send-as is enforced by Google OAuth — bot can never send as a user who didn't authorize.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 App Router (Fluid Compute) |
| LLM | Gemini 2.5 Flash via `@ai-sdk/google` |
| Memory / state | Upstash Redis |
| Scheduled jobs | Upstash QStash |
| Web search | Tavily |
| Google APIs | `googleapis` (Gmail send + Calendar) |
| Validation | Zod |
| Hosting | Vercel |

## Adding a new tool

1. Create `lib/tools/your-tool.ts`. Export a `buildYourTools(userId)` factory returning a record of `tool({ description, inputSchema, execute })`.
2. Add it to `lib/tools/index.ts` (gate on env if it has a dependency).

That's it — the model picks it up automatically on the next turn.

## Swapping the LLM

Edit `lib/llm/provider.ts` — return a different model handle. All call sites stay the same.
