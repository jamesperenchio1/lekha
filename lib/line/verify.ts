import crypto from "node:crypto";

/**
 * Verify the X-Line-Signature header on a webhook request.
 * Uses timing-safe comparison.
 */
export function verifyLineSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null,
  channelSecret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
