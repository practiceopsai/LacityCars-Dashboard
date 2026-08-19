import { describe, expect, it } from "vitest";
import { isExcludedStatus, normalizeLoadId, parseMoney, roundToCents } from "../normalize";

describe("normalizeLoadId", () => {
  it("expands scientific-notation strings to full digits", () => {
    expect(normalizeLoadId("1.23456789012E+11")).toBe("123456789012");
    expect(normalizeLoadId("1.2345e+4")).toBe("12345");
  });

  it("expands numeric cells", () => {
    expect(normalizeLoadId(123456789012)).toBe("123456789012");
  });

  it("strips trailing .0 and whitespace, uppercases", () => {
    expect(normalizeLoadId("12345.0")).toBe("12345");
    expect(normalizeLoadId("  ld-99 ")).toBe("LD-99");
  });

  it("returns null for empty/unusable values", () => {
    expect(normalizeLoadId(null)).toBeNull();
    expect(normalizeLoadId(undefined)).toBeNull();
    expect(normalizeLoadId("   ")).toBeNull();
    expect(normalizeLoadId(Number.NaN)).toBeNull();
  });
});

describe("parseMoney", () => {
  it("parses currency-formatted strings", () => {
    expect(parseMoney("$1,234.56")).toBe(1234.56);
    expect(parseMoney(" 900 ")).toBe(900);
  });

  it("passes numbers through and rejects garbage", () => {
    expect(parseMoney(750.5)).toBe(750.5);
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
});

describe("isExcludedStatus", () => {
  it("excludes cancelled, void, and declined variants", () => {
    for (const s of ["CANCELLED", "canceled", "Void", "VOIDED", "declined", "Decline"]) {
      expect(isExcludedStatus(s)).toBe(true);
    }
  });

  it("keeps active-ish statuses and blanks", () => {
    for (const s of ["Dispatched", "Delivered", "In Transit", "", null, undefined]) {
      expect(isExcludedStatus(s)).toBe(false);
    }
  });
});

describe("roundToCents", () => {
  it("rounds half-up to two decimals", () => {
    expect(roundToCents(333.333333)).toBe(333.33);
    expect(roundToCents(0.005)).toBe(0.01);
  });
});
