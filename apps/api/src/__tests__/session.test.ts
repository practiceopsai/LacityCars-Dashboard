import { describe, expect, it } from "vitest";
import { issueSessionToken, passwordsMatch, verifySessionToken } from "../services/session";

const SECRET = "session-secret-for-unit-tests";
const HOUR = 60 * 60 * 1000;

describe("session tokens", () => {
  it("round-trips a freshly issued token", () => {
    const token = issueSessionToken(SECRET, HOUR);
    expect(verifySessionToken(token, SECRET)).toBe(true);
  });

  it("rejects expired tokens", () => {
    const issuedAt = Date.now() - 2 * HOUR;
    const token = issueSessionToken(SECRET, HOUR, issuedAt);
    expect(verifySessionToken(token, SECRET)).toBe(false);
  });

  it("rejects tampered expiry", () => {
    const token = issueSessionToken(SECRET, HOUR);
    const [v, exp, sig] = token.split(".");
    const tampered = `${v}.${Number(exp) + 999999}.${sig}`;
    expect(verifySessionToken(tampered, SECRET)).toBe(false);
  });

  it("rejects tokens signed with a different secret", () => {
    const token = issueSessionToken("other-secret-entirely", HOUR);
    expect(verifySessionToken(token, SECRET)).toBe(false);
  });

  it("rejects garbage and undefined", () => {
    expect(verifySessionToken(undefined, SECRET)).toBe(false);
    expect(verifySessionToken("", SECRET)).toBe(false);
    expect(verifySessionToken("v1.notanumber.sig", SECRET)).toBe(false);
    expect(verifySessionToken("v2.123.sig", SECRET)).toBe(false);
  });
});

describe("passwordsMatch", () => {
  it("accepts equal passwords and rejects others in constant time", () => {
    expect(passwordsMatch("hunter2hunter2", "hunter2hunter2")).toBe(true);
    expect(passwordsMatch("hunter2hunter2", "hunter2hunter3")).toBe(false);
    expect(passwordsMatch("", "nonempty")).toBe(false);
  });
});
