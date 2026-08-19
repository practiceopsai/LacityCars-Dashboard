import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/**
 * Minimal stateless session for a single operator.
 * Token format: v1.<expiryEpochMs>.<hex HMAC-SHA256("v1.<expiry>", SESSION_SECRET)>
 * Carried in an httpOnly SameSite=Lax cookie; never readable by browser JS.
 */

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function issueSessionToken(secret: string, ttlMs: number, now = Date.now()): string {
  const payload = `v1.${now + ttlMs}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiry = Number(parts[1]);
  if (!Number.isFinite(expiry) || expiry < now) return false;

  const expected = sign(`v1.${parts[1]}`, secret);
  const given = parts[2]!;
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * Constant-time password comparison. Hashing both sides first normalizes
 * length so timingSafeEqual never throws and leaks length information.
 */
export function passwordsMatch(candidate: string, actual: string): boolean {
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(a, b);
}
