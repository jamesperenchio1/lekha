import { z } from "zod";

const Env = z.object({
  // LINE
  LINE_CHANNEL_SECRET: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),

  // LLM (one of)
  AI_GATEWAY_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  // Free-tier Gemini key (from a GCP project with no billing account attached).
  // Set GEMINI_TIER=free to activate it; omit or set GEMINI_TIER=paid to use GEMINI_API_KEY.
  GEMINI_API_KEY_FREE: z.string().optional(),
  GEMINI_TIER: z.enum(["free", "paid"]).optional(),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // Upstash Redis — Marketplace integration uses KV_REST_API_*, direct Upstash uses UPSTASH_REDIS_REST_*
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().min(1).optional(),

  // QStash
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),

  // Tavily
  TAVILY_API_KEY: z.string().optional(),

  // Groq (optional fallback when Gemini hits quota)
  GROQ_API_KEY: z.string().optional(),

  // Crypto
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 hex chars"),
  OAUTH_STATE_SECRET: z.string().min(32),

  // App
  APP_BASE_URL: z.string().url(),
  ADMIN_LINE_USER_ID: z.string().optional(),
});

export type EnvShape = z.infer<typeof Env>;

let cached: EnvShape | undefined;

export function env(): EnvShape {
  if (!cached) {
    const parsed = Env.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Resolve Upstash Redis credentials from either Marketplace (KV_*) or direct Upstash (UPSTASH_*) env vars. */
export function redisCreds(): { url: string; token: string } {
  const e = env();
  const url = e.UPSTASH_REDIS_REST_URL ?? e.KV_REST_API_URL;
  const token = e.UPSTASH_REDIS_REST_TOKEN ?? e.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Missing Redis credentials. Set UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL/KV_REST_API_TOKEN.",
    );
  }
  return { url, token };
}

export function hasGoogleOAuth(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.GOOGLE_REDIRECT_URI);
}

export function hasQStash(): boolean {
  const e = env();
  return Boolean(e.QSTASH_TOKEN && e.QSTASH_CURRENT_SIGNING_KEY);
}
