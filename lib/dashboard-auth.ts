import { hmac, safeEqual } from "@/lib/memory/crypto";
import { env } from "@/lib/env";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Build a signed 7-day dashboard access token for the given userId. */
export function buildDashboardToken(userId: string): string {
  const expiresAt = Date.now() + TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  const sig = hmac(payload, env().OAUTH_STATE_SECRET);
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

/** Verify a dashboard token and return the userId. Throws on invalid/expired. */
export function verifyDashboardToken(token: string): string {
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
