import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyExtractionCallback } from "../extract/pdfHermes";
import { verifySvixSignature } from "../svix";

const SECRET_BYTES = Buffer.from("test-secret-material-32-bytes!!!", "utf8");
const WHSEC = `whsec_${SECRET_BYTES.toString("base64")}`;

function sign(id: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", SECRET_BYTES)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${digest}`;
}

describe("verifySvixSignature", () => {
  const body = '{"event_type":"message.received","message_id":"m1"}';
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000));

  it("accepts a valid v1 signature", () => {
    const headers = { id: "msg_1", timestamp, signature: sign("msg_1", timestamp, body) };
    expect(verifySvixSignature(body, headers, WHSEC, now).ok).toBe(true);
  });

  it("accepts when a valid signature is one of several space-delimited entries", () => {
    const headers = {
      id: "msg_1",
      timestamp,
      signature: `v1,${Buffer.from("wrong").toString("base64")} ${sign("msg_1", timestamp, body)}`,
    };
    expect(verifySvixSignature(body, headers, WHSEC, now).ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const headers = { id: "msg_1", timestamp, signature: sign("msg_1", timestamp, body) };
    expect(verifySvixSignature(body.replace("m1", "m2"), headers, WHSEC, now).ok).toBe(false);
  });

  it("rejects a stale timestamp", () => {
    const old = String(Math.floor(now / 1000) - 3600);
    const headers = { id: "msg_1", timestamp: old, signature: sign("msg_1", old, body) };
    const verdict = verifySvixSignature(body, headers, WHSEC, now);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("tolerance");
  });

  it("rejects missing headers", () => {
    expect(
      verifySvixSignature(body, { id: undefined, timestamp, signature: undefined }, WHSEC, now).ok,
    ).toBe(false);
  });
});

describe("verifyExtractionCallback", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const body = '{"request_id":"m1","vehicles":[]}';
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

  it("accepts a valid signature", () => {
    expect(verifyExtractionCallback(body, timestamp, signature, secret, now)).toBe(true);
  });

  it("rejects a tampered body and a stale timestamp", () => {
    expect(verifyExtractionCallback(body + " ", timestamp, signature, secret, now)).toBe(false);
    const old = String(Math.floor(now / 1000) - 3600);
    const oldSig = createHmac("sha256", secret).update(`${old}.${body}`).digest("hex");
    expect(verifyExtractionCallback(body, old, oldSig, secret, now)).toBe(false);
  });
});
