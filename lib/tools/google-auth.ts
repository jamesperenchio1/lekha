import { google } from "googleapis";
import { redis } from "@/lib/memory/redis";
import { encrypt, decrypt, hmac, safeEqual } from "@/lib/memory/crypto";
import { env, hasGoogleOAuth } from "@/lib/env";
import { GoogleAuthRequired } from "@/lib/errors";

export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];

type StoredTokens = {
  access_token: string;
  refresh_token: string;
  expiry_date: number; // ms
  scope: string;
};

const tokensKey = (userId: string) => `google:tokens:${userId}`;
const stateKey = (nonce: string) => `oauth:state:${nonce}`;

function oauth2Client() {
  const e = env();
  if (!hasGoogleOAuth()) throw new Error("Google OAuth env vars not set");
  return new google.auth.OAuth2(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET, e.GOOGLE_REDIRECT_URI);
}

/** Build a signed connect-link the user can open from LINE. */
export function buildConnectUrl(userId: string): string {
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min
  const payload = `${userId}.${expiresAt}`;
  const sig = hmac(payload, env().OAUTH_STATE_SECRET);
  const token = Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
  return `${env().APP_BASE_URL}/connect/${token}`;
}

/** Validate a connect-link token and return the userId. */
export function verifyConnectToken(token: string): string {
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const parts = decoded.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [userId, expiresAtStr, sig] = parts as [string, string, string];
  const expected = hmac(`${userId}.${expiresAtStr}`, env().OAUTH_STATE_SECRET);
  if (!safeEqual(sig, expected)) throw new Error("bad signature");
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) throw new Error("expired");
  return userId;
}

/** Generate the Google consent URL for this user. Stores a server-side nonce so we can verify the callback. */
export async function startOAuth(userId: string): Promise<string> {
  const client = oauth2Client();
  const nonce = crypto.randomUUID();
  await redis().set(stateKey(nonce), { userId }, { ex: 600 });
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token
    scope: SCOPES,
    state: nonce,
    include_granted_scopes: true,
  });
}

/** Exchange an OAuth callback code → store encrypted tokens. Returns the userId. */
export async function completeOAuth(code: string, state: string): Promise<string> {
  const stored = await redis().get<{ userId: string }>(stateKey(state));
  if (!stored) throw new Error("invalid or expired state");
  await redis().del(stateKey(state));
  const client = oauth2Client();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token (was the user already connected? revoke and retry)");
  }
  const toStore: StoredTokens = {
    access_token: tokens.access_token ?? "",
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ?? Date.now() + 50 * 60 * 1000,
    scope: tokens.scope ?? SCOPES.join(" "),
  };
  await redis().set(tokensKey(stored.userId), encrypt(JSON.stringify(toStore)));
  return stored.userId;
}

export async function hasGoogleConnection(userId: string): Promise<boolean> {
  return (await redis().exists(tokensKey(userId))) === 1;
}

/**
 * Get an OAuth2 client authorized for this user, refreshing if needed.
 * Throws GoogleAuthRequired if the user hasn't connected yet.
 */
export async function getGoogleClient(userId: string) {
  const blob = await redis().get<string>(tokensKey(userId));
  if (!blob) throw new GoogleAuthRequired(SCOPES);
  const tokens = JSON.parse(decrypt(blob)) as StoredTokens;
  const client = oauth2Client();
  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    scope: tokens.scope,
  });
  // Persist any refreshed tokens back to Redis.
  client.on("tokens", async (newTokens) => {
    const merged: StoredTokens = {
      access_token: newTokens.access_token ?? tokens.access_token,
      refresh_token: newTokens.refresh_token ?? tokens.refresh_token,
      expiry_date: newTokens.expiry_date ?? tokens.expiry_date,
      scope: newTokens.scope ?? tokens.scope,
    };
    await redis().set(tokensKey(userId), encrypt(JSON.stringify(merged)));
  });
  return client;
}
