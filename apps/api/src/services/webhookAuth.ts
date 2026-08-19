import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Hermes webhook authentication.
 * Hermes signs the raw request body: X-Hermes-Signature: sha256=<hex HMAC-SHA256(body, secret)>
 * Comparison is constant-time. See docs/hermes-contract.md.
 */

export function computeWebhookSignature(rawBody: Buffer | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = computeWebhookSignature(rawBody, secret);
  const given = signatureHeader.trim();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
}

/** Idempotency key: the delivery header when present, else a hash of the raw body. */
export function webhookDedupeKey(
  rawBody: Buffer | string,
  deliveryHeader: string | undefined,
): string {
  if (deliveryHeader && deliveryHeader.trim()) {
    return `delivery:${deliveryHeader.trim()}`;
  }
  return `body:${createHash("sha256").update(rawBody).digest("hex")}`;
}
