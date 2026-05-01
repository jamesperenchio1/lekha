# Lekha — setup walkthrough

This file walks through everything you need to do once to get the bot live.
Order matters — services depend on each other.

> Heads up: paste secrets into your shell or `.env.local`, never into chat.

---

## 1. Generate your encryption keys

```bash
echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "OAUTH_STATE_SECRET=$(openssl rand -hex 32)"
```

Save both for step 8.

---

## 2. LINE channel access token

1. <https://developers.line.biz/console/> → your provider → channel `2009944232`.
2. **Messaging API** tab → **Channel access token** → **Issue** (long-lived). Save as `LINE_CHANNEL_ACCESS_TOKEN`.
3. Same tab: **disable** "Auto-reply messages" and "Greeting messages".
4. Webhook URL — leave empty for now; we'll fill after deploy (step 9).

Channel secret: `185cd47094c024f97b846e7d73b4d16f` (already known).

---

## 3. Google Cloud — OAuth + APIs

1. <https://console.cloud.google.com/> — sign in as the Google account you want to *own* the project.
2. Top bar → **New Project** → name it `lekha`.
3. **APIs & Services → Library** → enable ALL of:
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - People API (for Contacts)
4. **OAuth consent screen** → External / Testing.
   - App name: `Lekha`. Support + dev email: yours.
   - **Test users**: add every Gmail you'll OAuth into the bot from.
5. **Credentials → Create Credentials → OAuth client ID** → **Web application**.
   - Authorized redirect URI: `https://YOUR-VERCEL-URL/api/oauth/google/callback` (placeholder OK; you'll edit after step 8).
   - Save Client ID + Client Secret.

---

## 4. Tavily (web search)

<https://tavily.com/> → sign up (free 1000/mo). Save `TAVILY_API_KEY`.

---

## 5. Gemini API key (under the same Google account that owns the Cloud project!)

<https://aistudio.google.com/app/apikey> → **Create API key**. Save `GEMINI_API_KEY`. Free tier is fine; consider enabling billing later for higher RPM.

---

## 6. Vercel project

```bash
npx vercel link
```

Pick a name (e.g. `lekha`). Note the URL it gives you (e.g. `https://lekha-iota.vercel.app`). Use that everywhere `APP_BASE_URL` / `GOOGLE_REDIRECT_URI` appear.

---

## 7. Provision storage via Vercel Marketplace

Vercel dashboard → your project → **Storage** tab:

1. **Add Integration → Upstash → Redis** (KV product). Auto-injects `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
2. **Add Integration → Upstash → QStash**. Auto-injects `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_URL`.

Both have generous free tiers.

---

## 8. Push the rest of the env vars

```bash
vercel env add LINE_CHANNEL_SECRET production preview development
vercel env add LINE_CHANNEL_ACCESS_TOKEN production preview development
vercel env add GEMINI_API_KEY production preview development
vercel env add GOOGLE_CLIENT_ID production preview development
vercel env add GOOGLE_CLIENT_SECRET production preview development
vercel env add GOOGLE_REDIRECT_URI production preview development   # https://your-app.vercel.app/api/oauth/google/callback
vercel env add TAVILY_API_KEY production preview development
vercel env add TOKEN_ENCRYPTION_KEY production preview development
vercel env add OAUTH_STATE_SECRET production preview development
vercel env add APP_BASE_URL production preview development          # https://your-app.vercel.app
```

(The current Vercel CLI requires one env per call — repeat for each.)

Pull locally for dev: `vercel env pull .env.local`.

---

## 9. Deploy

```bash
vercel deploy --prod
```

Note the URL. Make sure it matches what you set as `APP_BASE_URL` and `GOOGLE_REDIRECT_URI`. If not, update those env vars and redeploy.

---

## 10. Tell LINE about the webhook

In the LINE console → Messaging API tab:

1. **Webhook URL** = `https://YOUR-VERCEL-URL/api/line/webhook`
2. **Verify** → 200 expected.
3. **Use webhook** → ON.

---

## 11. (Optional but recommended) Schedule the proactive cron sweep

The bot can push you a daily morning briefing and pre-meeting reminders, but the proactive layer needs a recurring trigger. Set up a QStash schedule that hits `/api/cron/sweep` every 15 minutes:

**Option A — Upstash QStash dashboard:**
1. <https://console.upstash.com/qstash> → **Schedules** → **Create**.
2. Destination: `https://YOUR-VERCEL-URL/api/cron/sweep`
3. Cron: `*/15 * * * *`
4. Method: POST
5. Body: `{}`
6. Save.

**Option B — curl from your terminal** (fill in your QSTASH_TOKEN — pulled from `vercel env pull .env.local`):

```bash
curl -XPOST https://qstash.upstash.io/v2/schedules/https://YOUR-VERCEL-URL/api/cron/sweep \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: */15 * * * *" \
  -H "Content-Type: application/json" \
  -d '{}'
```

To test the sweep manually without waiting for the schedule:

```bash
# Manual trigger — uses your OAUTH_STATE_SECRET as a bearer token (already in env)
curl -XPOST https://YOUR-VERCEL-URL/api/cron/sweep \
  -H "Authorization: Bearer $OAUTH_STATE_SECRET"
```

If you skip this step, the bot still works — you just won't get morning briefings or pre-meeting alerts.

---

## 12. Smoke test from your phone

Add the LINE Official Account, then try:

| | |
|---|---|
| `hi` | greeting |
| `help` | bot lists every capability |
| `set my timezone to Asia/Bangkok` | persisted |
| `remember I prefer espresso` | saved |
| `add a task to ship the cert pdf` | task created |
| `list my tasks` | shows it |
| `email mom about the cert` | bot uses contacts_search → drafts → YES → sent |
| Send any photo + `extract text from this` | OCR reply |
| Send a voice memo + `transcribe this` | transcript reply |
| Send a PDF + `summarize this document` | bullet-point summary |
| Send a PDF + `save this to my drive` | uploaded |
| `send me a daily briefing at 7am` | enabled — verify with manual cron trigger above |
| `remind me 15 min before each meeting` | pre-meeting alerts on |
| `what did i send to bob today` | sent_history |

To watch what's happening: `npx vercel logs YOUR-URL`.

---

## Local development

```bash
npm install
vercel env pull .env.local
npm run dev
# Public-tunnel for LINE webhook:
ngrok http 3000
# Set LINE webhook URL to https://<ngrok>/api/line/webhook
```

Don't forget to flip the LINE webhook URL back to prod when done.
