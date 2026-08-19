/**
 * Normalize a load identifier from arbitrary workbook cell content.
 * Handles numeric cells, scientific-notation strings Excel produces for long
 * numeric IDs (e.g. "1.23456789012E+12"), and decimal-formatted integers ("12345.0").
 * Returns null when the cell holds no usable identifier.
 */
export function normalizeLoadId(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // toFixed(0) expands integer scientific notation into full digits.
    text = value.toFixed(0);
  } else {
    text = String(value).trim();
  }
  if (!text) return null;

  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(text)) {
    const num = Number(text);
    if (!Number.isFinite(num)) return null;
    text = num.toFixed(0);
  }

  text = text.replace(/\.0+$/, "");
  text = text.replace(/\s+/g, "").toUpperCase();
  return text || null;
}

/** Parse a money cell: numbers pass through; strings may carry $, commas, spaces. */
export function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const text = String(value).replace(/[$,\s]/g, "");
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/** Rows whose status marks them cancelled/void/declined are excluded entirely. */
export function isExcludedStatus(status: unknown): boolean {
  if (status === null || status === undefined) return false;
  return /cancel|void|declin/i.test(String(status));
}

/** Round to cents using half-up rounding. */
export function roundToCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
