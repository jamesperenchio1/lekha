import crypto from "node:crypto";
import { env } from "@/lib/env";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  return Buffer.from(env().TOKEN_ENCRYPTION_KEY, "hex");
}

/** Encrypt a UTF-8 string. Returns base64url(iv|tag|ciphertext). */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64url");
}

/** Decrypt the format produced by encrypt(). */
export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/** HMAC-SHA256 → base64url. */
export function hmac(message: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("base64url");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
