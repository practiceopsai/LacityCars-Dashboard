import { describe, expect, it } from "vitest";
import {
  computeWebhookSignature,
  verifyWebhookSignature,
  webhookDedupeKey,
} from "../services/webhookAuth";

const SECRET = "test-webhook-secret-for-unit-tests";
const BODY = JSON.stringify({ vin: "1HGCM82633A004352", status: "COMPLETED" });

describe("webhook signature", () => {
  it("accepts a correctly signed body", () => {
    const signature = computeWebhookSignature(BODY, SECRET);
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(verifyWebhookSignature(BODY, signature, SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(BODY), signature, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = computeWebhookSignature(BODY, SECRET);
    const tampered = BODY.replace("COMPLETED", "FAILED");
    expect(verifyWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a signature produced with the wrong secret", () => {
    const signature = computeWebhookSignature(BODY, "some-other-secret-value");
    expect(verifyWebhookSignature(BODY, signature, SECRET)).toBe(false);
  });

  it("rejects missing or malformed signatures without throwing", () => {
    expect(verifyWebhookSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "sha256=short", SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "garbage", SECRET)).toBe(false);
  });
});

describe("webhook dedupe key (idempotency)", () => {
  it("prefers the delivery header when present", () => {
    expect(webhookDedupeKey(BODY, "delivery-123")).toBe("delivery:delivery-123");
    expect(webhookDedupeKey("different body", "delivery-123")).toBe("delivery:delivery-123");
  });

  it("falls back to a stable body hash", () => {
    const a = webhookDedupeKey(BODY, undefined);
    const b = webhookDedupeKey(BODY, "  ");
    expect(a).toBe(b);
    expect(a.startsWith("body:")).toBe(true);
    expect(webhookDedupeKey("other", undefined)).not.toBe(a);
  });
});
