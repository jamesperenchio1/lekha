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

1. Go to <https://developers.line.biz/console/> → your provider → channel `2009944232`.
2. **Messaging API** tab → scroll to **Channel access token** → click **Issue** (long-lived).
3. Copy it — you only see it once. Save as `LINE_CHANNEL_ACCESS_TOKEN`.
4. Same tab: scroll up, **disable** "Auto-reply messages" and "Greeting messages" (they conflict with the bot).
5. **Webhook URL** field — leave empty for now; we'll set it after deploy (step 9).

The channel secret you already have: `185cd47094c024f97b846e7d73b4d16f`.

---

## 3. Google Cloud — OAuth + APIs

1. <https://console.cloud.google.com/> → create a project (e.g. "lekha").
2. **APIs & Services → Library** → enable:
   - Gmail API
   - Google Calendar API
3. **OAuth consent screen**:
   - User type: **External**, status: **Testing** (fine for personal/small use; up to 100 test users).
   - App name: Lekha. Support email: your email. Developer email: same.
   - Scopes: add `gmail.send` and `calendar.events`. (You can also add `openid email profile` — already in our default scope list.)
   - Test users: add every Gmail address that will use the bot (otherwise OAuth blocks them).
4. **Credentials → Create Credentials → OAuth client ID**:
   - Type: **Web application**.
   - Authorized redirect URI: `https://YOUR-VERCEL-URL/api/oauth/google/callback` — use the URL Vercel gives you in step 7. (You can edit this later; just remember to come back.)
5. Save **Client ID** and **Client Secret** as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

---

## 4. Tavily (web search)

1. <https://tavily.com/> → sign up (free tier: 1000 searches/mo).
2. Copy API key. Save as `TAVILY_API_KEY`.

---

## 5. Vercel project

```bash
npx vercel link        # creates the project + links this directory
```

Pick a project name (e.g. `lekha`). After linking, your prod URL is `https://lekha.vercel.app` (or whatever you chose). Update `APP_BASE_URL` and `GOOGLE_REDIRECT_URI` accordingly.

---

## 6. Provision storage via Vercel Marketplace

From the Vercel dashboard → your project → **Storage** tab:

1. **Add Integration → Upstash → Redis**. Pick the closest region. After install, env vars `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` auto-link.
2. **Add Integration → Upstash → QStash**. Auto-links `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`.

(Both have generous free tiers.)

---

## 7. Set the rest of the env vars

```bash
vercel env add LINE_CHANNEL_SECRET production preview development
vercel env add LINE_CHANNEL_ACCESS_TOKEN production preview development
vercel env add GEMINI_API_KEY production preview development         # from https://aistudio.google.com/app/apikey
vercel env add GOOGLE_CLIENT_ID production preview development
vercel env add GOOGLE_CLIENT_SECRET production preview development
vercel env add GOOGLE_REDIRECT_URI production preview development    # https://your-app.vercel.app/api/oauth/google/callback
vercel env add TAVILY_API_KEY production preview development
vercel env add TOKEN_ENCRYPTION_KEY production preview development
vercel env add OAUTH_STATE_SECRET production preview development
vercel env add APP_BASE_URL production preview development           # https://your-app.vercel.app
```

Then pull them locally for dev:

```bash
vercel env pull .env.local
```

---

## 8. Deploy

```bash
vercel deploy --prod
```

Note the deployed URL.

---

## 9. Tell LINE about the webhook

In the LINE console (same place as step 2):

1. **Webhook URL**: `https://YOUR-VERCEL-URL/api/line/webhook`
2. **Verify** → should return 200.
3. Toggle **Use webhook** ON.

---

## 10. Smoke test from your phone

Add the Official Account on LINE, then send:

| Message | Expected |
|---|---|
| `hi` | Greeting reply, history saved |
| `remember that I prefer coffee over tea` | Bot acknowledges; future replies factor it in |
| `remind me in 2 minutes to drink water` | Confirmation, then ⏰ push 2 min later |
| `what's the weather in Tokyo right now` | Web-search tool fires |
| Send a photo of food | Bot describes it |
| `email me at YOUR_EMAIL saying hello` | Bot returns connect link → after OAuth, draft + YES gate, then sends |

If something looks off, tail logs:

```bash
vercel logs https://YOUR-VERCEL-URL --follow
```

---

## Local development

```bash
npm install
vercel env pull .env.local
npm run dev
```

For LINE to reach your local server, expose it with a tunnel:

```bash
ngrok http 3000
# update LINE webhook URL to https://<ngrok>.ngrok-free.app/api/line/webhook
```

Don't forget to switch the LINE webhook back to your prod URL after.
