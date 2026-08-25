import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Standard Svix webhook signature verification (AgentMail uses Svix).
 * Signed content is `${svix-id}.${svix-timestamp}.${rawBody}`; the secret is the
 * base64 payload after the `whsec_` prefix; the signature header holds one or
 * more space-delimited `v1,<base64>` entries.
 */
export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export function verifySvixSignature(
  rawBody: Buffer | string,
  headers: SvixHeaders,
  secret: string,
  nowMs: number = Date.now(),
  toleranceMs = 300_000,
): { ok: boolean; reason?: string } {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: "missing svix headers" };
  }
  const timestampSec = Number(headers.timestamp);
  if (!Number.isFinite(timestampSec)) {
    return { ok: false, reason: "invalid svix timestamp" };
  }
  if (Math.abs(nowMs - timestampSec * 1000) > toleranceMs) {
    return { ok: false, reason: "svix timestamp outside tolerance" };
  }

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (secretBytes.length === 0) {
    return { ok: false, reason: "empty webhook secret" };
  }
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secretBytes)
    .update(`${headers.id}.${headers.timestamp}.${body}`)
    .digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");

  for (const entry of headers.signature.split(" ")) {
    const [version, signature] = entry.split(",", 2);
    if (version !== "v1" || !signature) continue;
    const givenBuf = Buffer.from(signature, "utf8");
    if (givenBuf.length === expectedBuf.length && timingSafeEqual(givenBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "no matching v1 signature" };
}
