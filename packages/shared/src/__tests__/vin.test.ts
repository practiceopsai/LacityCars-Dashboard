import { describe, expect, it } from "vitest";
import { computeVinCheckDigit, maskVin, normalizeVin, validateVin } from "../vin";

// Canonical publicly documented valid VIN (check digit '3' at position 9).
const VALID_VIN = "1HGCM82633A004352";

/** Build a valid VIN from a 17-char skeleton by fixing its check digit. */
function withValidCheckDigit(skeleton: string): string {
  const digit = computeVinCheckDigit(skeleton);
  return skeleton.slice(0, 8) + digit + skeleton.slice(9);
}

describe("normalizeVin", () => {
  it("uppercases and strips whitespace and dashes", () => {
    expect(normalizeVin(" 1hgcm826-33a 004352 ")).toBe(VALID_VIN);
  });
});

describe("validateVin", () => {
  it("accepts a known-valid VIN", () => {
    const result = validateVin(VALID_VIN);
    expect(result.ok).toBe(true);
    expect(result.vin).toBe(VALID_VIN);
    expect(result.errors).toEqual([]);
  });

  it("normalizes before validating", () => {
    expect(validateVin("1hgcm82633a004352").ok).toBe(true);
  });

  it("rejects wrong length", () => {
    const result = validateVin("1HGCM82633A00435");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/17 characters/);
  });

  it("rejects I, O, and Q", () => {
    for (const bad of ["I", "O", "Q"]) {
      const result = validateVin(VALID_VIN.slice(0, 16) + bad);
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toMatch(/I, O, or Q/);
    }
  });

  it("rejects non-alphanumeric characters", () => {
    expect(validateVin("1HGCM82633A00435!").ok).toBe(false);
  });

  it("rejects an incorrect check digit", () => {
    const tampered = VALID_VIN.slice(0, 8) + "4" + VALID_VIN.slice(9);
    const result = validateVin(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/check digit/);
  });

  it("accepts constructed VINs with computed check digits", () => {
    const vin = withValidCheckDigit("5YJ3E1EA0HF000000");
    expect(validateVin(vin).ok).toBe(true);
  });

  it("uses X for a check-digit remainder of 10", () => {
    // Scan a family of skeletons until one produces the 'X' check digit,
    // then assert the validator round-trips it.
    let found: string | null = null;
    for (let i = 0; i < 30 && !found; i++) {
      const skeleton = `5YJ3E1EA0HF00${String(i).padStart(4, "0")}`;
      if (computeVinCheckDigit(skeleton) === "X") found = withValidCheckDigit(skeleton);
    }
    expect(found).not.toBeNull();
    expect(validateVin(found!).ok).toBe(true);
    expect(found![8]).toBe("X");
  });
});

describe("maskVin", () => {
  it("shows first 3 and last 6 characters", () => {
    expect(maskVin(VALID_VIN)).toBe("1HG…004352");
  });

  it("passes through non-17-char strings unchanged", () => {
    expect(maskVin("SHORT")).toBe("SHORT");
  });
});
