/**
 * Strict VIN handling per ISO 3779 / FMVSS 115.
 * A valid VIN is exactly 17 characters, alphanumeric excluding I, O, Q,
 * with a check digit at position 9 (North American standard).
 */

const VIN_ALLOWED = /^[A-HJ-NPR-Z0-9]{17}$/;

const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
  "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Uppercase and strip whitespace/dashes. Does not validate. */
export function normalizeVin(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

/**
 * Compute the ISO 3779 check digit for a 17-char VIN candidate.
 * The existing character at position 9 is ignored.
 */
export function computeVinCheckDigit(vin: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]!;
    const value = TRANSLITERATION[ch];
    if (value === undefined) {
      throw new Error(`Invalid VIN character '${ch}' at position ${i + 1}`);
    }
    sum += value * WEIGHTS[i]!;
  }
  const remainder = sum % 11;
  return remainder === 10 ? "X" : String(remainder);
}

export interface VinValidationResult {
  ok: boolean;
  /** Normalized VIN when structurally usable (17 allowed chars), even if the check digit failed. */
  vin?: string;
  errors: string[];
}

export function validateVin(raw: string): VinValidationResult {
  const vin = normalizeVin(raw);
  const errors: string[] = [];

  if (vin.length !== 17) {
    errors.push(`VIN must be exactly 17 characters (got ${vin.length})`);
    return { ok: false, errors };
  }
  if (/[IOQ]/.test(vin)) {
    errors.push("VIN may not contain the letters I, O, or Q");
  }
  if (!VIN_ALLOWED.test(vin)) {
    errors.push("VIN may only contain letters (except I, O, Q) and digits");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const expected = computeVinCheckDigit(vin);
  if (vin[8] !== expected) {
    return {
      ok: false,
      vin,
      errors: [`VIN check digit is invalid (position 9 is '${vin[8]}', expected '${expected}')`],
    };
  }
  return { ok: true, vin, errors: [] };
}

/** Short display form: first 3 + last 6 with a masked middle. Full VIN must remain accessible. */
export function maskVin(vin: string): string {
  if (vin.length !== 17) return vin;
  return `${vin.slice(0, 3)}…${vin.slice(-6)}`;
}
