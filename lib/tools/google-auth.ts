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
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
];

type StoredTokens = {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  scope: string;
};

export type Account = {
  email: string;
  addedAt: number;
};

type AccountsBlob = {
  accounts: Account[];
  activeEmail: string | null;
};

const accountsKey = (userId: string) => `google:accounts:${userId}`;
const tokensKey = (userId: string, email: string) => `google:tokens:${userId}:${email}`;
const legacyTokensKey = (userId: string) => `google:tokens:${userId}`; // pre-multi-account
const stateKey = (nonce: string) => `oauth:state:${nonce}`;
const connectLinkKey = (sigB64u: string) => `oauth:connect_link:${sigB64u}`;

function oauth2Client() {
  const e = env();
  if (!hasGoogleOAuth()) throw new Error("Google OAuth env vars not set");
  return new google.auth.OAuth2(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET, e.GOOGLE_REDIRECT_URI);
}

/**
 * Build a signed, server-side single-use connect link.
 * The HMAC alone isn't enough — anyone who saw the link could replay it within the TTL window.
 * We additionally write a Redis marker keyed by the signature; verifyConnectToken consumes it atomically.
 */
export async function buildConnectUrl(userId: string): Promise<string> {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const payload = `${userId}.${expiresAt}`;
  const sig = hmac(payload, env().OAUTH_STATE_SECRET);
  await redis().set(connectLinkKey(sig), { userId, expiresAt }, { ex: 10 * 60 });
  const token = Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
  return `${env().APP_BASE_URL}/connect/${token}`;
}

/** Validate AND consume a connect-link token. Returns the userId; subsequent uses fail. */
export async function verifyConnectToken(token: string): Promise<string> {
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const parts = decoded.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [userId, expiresAtStr, sig] = parts as [string, string, string];
  const expected = hmac(`${userId}.${expiresAtStr}`, env().OAUTH_STATE_SECRET);
  if (!safeEqual(sig, expected)) throw new Error("bad signature");
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) throw new Error("expired");
  // Atomic single-use consumption.
  const consumed = await redis().getdel<{ userId: string }>(connectLinkKey(sig));
  if (!consumed || consumed.userId !== userId) throw new Error("link already used or expired");
  return userId;
}

/** Generate the Google consent URL for this user. Stores a server-side nonce. */
export async function startOAuth(userId: string): Promise<string> {
  const client = oauth2Client();
  const nonce = crypto.randomUUID();
  await redis().set(stateKey(nonce), { userId }, { ex: 600 });
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: nonce,
    include_granted_scopes: true,
  });
}

/** Exchange an OAuth callback code → store encrypted tokens keyed by email.
 * Returns { userId, email } so the caller can notify and resume. */
export async function completeOAuth(
  code: string,
  state: string,
): Promise<{ userId: string; email: string }> {
  // Atomic single-use consumption — prevents replay if two callbacks land concurrently.
  const stored = await redis().getdel<{ userId: string }>(stateKey(state));
  if (!stored) throw new Error("invalid or expired state");
  const client = oauth2Client();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. If you've already connected this account, revoke it at https://myaccount.google.com/permissions and retry.",
    );
  }

  // Discover which email this token belongs to.
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const profile = await oauth2.userinfo.get();
  const email = profile.data.email;
  if (!email) throw new Error("Google did not return an email");

  const toStore: StoredTokens = {
    access_token: tokens.access_token ?? "",
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ?? Date.now() + 50 * 60 * 1000,
    scope: tokens.scope ?? SCOPES.join(" "),
  };
  await redis().set(tokensKey(stored.userId, email), encrypt(JSON.stringify(toStore)));
  await addAccount(stored.userId, email, /*activate*/ true);
  return { userId: stored.userId, email };
}

async function loadAccounts(userId: string): Promise<AccountsBlob> {
  const blob = await redis().get<AccountsBlob>(accountsKey(userId));
  if (blob && blob.accounts) return blob;

  // Legacy migration: if there are tokens at the old key, treat them as the
  // primary account once we discover the email.
  const legacy = await redis().get<string>(legacyTokensKey(userId));
  if (legacy) {
    try {
      const tokens = JSON.parse(decrypt(legacy)) as StoredTokens;
      const client = oauth2Client();
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const profile = await oauth2.userinfo.get();
      const email = profile.data.email;
      if (email) {
        await redis().set(tokensKey(userId, email), legacy);
        await redis().del(legacyTokensKey(userId));
        const migrated: AccountsBlob = {
          accounts: [{ email, addedAt: Date.now() }],
          activeEmail: email,
        };
        await redis().set(accountsKey(userId), migrated);
        return migrated;
      }
    } catch {
      // ignore; treat as no accounts
    }
  }

  return { accounts: [], activeEmail: null };
}

async function saveAccounts(userId: string, blob: AccountsBlob): Promise<void> {
  await redis().set(accountsKey(userId), blob);
}

async function addAccount(userId: string, email: string, activate: boolean): Promise<void> {
  const blob = await loadAccounts(userId);
  if (!blob.accounts.some((a) => a.email === email)) {
    blob.accounts.push({ email, addedAt: Date.now() });
  }
  if (activate || !blob.activeEmail) blob.activeEmail = email;
  await saveAccounts(userId, blob);
}

export async function listAccounts(userId: string): Promise<{
  accounts: Account[];
  activeEmail: string | null;
}> {
  return loadAccounts(userId);
}

export async function setActiveAccount(userId: string, email: string): Promise<boolean> {
  const blob = await loadAccounts(userId);
  if (!blob.accounts.some((a) => a.email === email)) return false;
  blob.activeEmail = email;
  await saveAccounts(userId, blob);
  return true;
}

export async function removeAccount(userId: string, email: string): Promise<boolean> {
  const blob = await loadAccounts(userId);
  const before = blob.accounts.length;
  blob.accounts = blob.accounts.filter((a) => a.email !== email);
  if (blob.activeEmail === email) {
    blob.activeEmail = blob.accounts[0]?.email ?? null;
  }
  await saveAccounts(userId, blob);
  await redis().del(tokensKey(userId, email));
  return blob.accounts.length !== before;
}

export async function hasGoogleConnection(userId: string): Promise<boolean> {
  const blob = await loadAccounts(userId);
  return blob.accounts.length > 0 && blob.activeEmail !== null;
}

/**
 * Get an OAuth2 client for a specific account (or the active one), refreshing if needed.
 * Throws GoogleAuthRequired if no matching account is connected, or if the stored
 * token is missing scopes the caller will need (forces a re-consent).
 */
export async function getGoogleClient(userId: string, email?: string, requiredScopes: string[] = []) {
  const blob = await loadAccounts(userId);
  const target = email ?? blob.activeEmail;
  if (!target || !blob.accounts.some((a) => a.email === target)) {
    throw new GoogleAuthRequired(SCOPES);
  }
  const stored = await redis().get<string>(tokensKey(userId, target));
  if (!stored) throw new GoogleAuthRequired(SCOPES);
  const tokens = JSON.parse(decrypt(stored)) as StoredTokens;
  if (requiredScopes.length) {
    const grantedScopes = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean));
    const missing = requiredScopes.filter((s) => !grantedScopes.has(s));
    if (missing.length) {
      console.warn("[google-auth] missing scopes for", target, missing);
      throw new GoogleAuthRequired(SCOPES);
    }
  }
  const client = oauth2Client();
  client.setCredentials(tokens);
  client.on("tokens", async (newTokens) => {
    const merged: StoredTokens = {
      access_token: newTokens.access_token ?? tokens.access_token,
      refresh_token: newTokens.refresh_token ?? tokens.refresh_token,
      expiry_date: newTokens.expiry_date ?? tokens.expiry_date,
      scope: newTokens.scope ?? tokens.scope,
    };
    await redis().set(tokensKey(userId, target), encrypt(JSON.stringify(merged)));
  });
  return { client, email: target };
}
