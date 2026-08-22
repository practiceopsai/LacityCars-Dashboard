import { normalizeVin } from "@lacity/shared";
import { isExcludedStatus, normalizeLoadId, parseMoney, roundToCents } from "./normalize";
import type { DispatchRow, FreightResult } from "./types";

/**
 * Compute per-car freight for a VIN from parsed dispatch rows.
 *
 * Rules (see spec):
 * - Exact normalized 17-character VIN match only.
 * - Cancelled/void/declined rows are excluded before any matching or counting.
 * - Per-car freight = whole load price / count of DISTINCT active VINs on the
 *   normalized load (duplicate rows for one VIN count once).
 * - Any ambiguity (multiple active loads, conflicting load prices) is reported
 *   as not-found — freight is NEVER estimated.
 */
export function calculateFreight(rows: DispatchRow[], rawVin: string): FreightResult {
  const targetVin = normalizeVin(rawVin);

  const activeRows = rows.filter((row) => !isExcludedStatus(row.status));

  const matchedRows = activeRows.filter((row) => {
    if (row.vin === null || row.vin === undefined) return false;
    return normalizeVin(String(row.vin)) === targetVin;
  });
  if (matchedRows.length === 0) {
    return {
      found: false,
      reason: "VIN_NOT_FOUND",
      detail: `VIN ${targetVin} has no active row in the dispatch workbook`,
    };
  }

  const loadKeys = new Set<string>();
  for (const row of matchedRows) {
    const loadId = normalizeLoadId(row.loadId);
    if (loadId) loadKeys.add(`${row.worksheetName ?? ""}\u0000${loadId}`);
  }
  if (loadKeys.size === 0) {
    return {
      found: false,
      reason: "NO_ACTIVE_LOAD",
      detail: `VIN ${targetVin} matched rows ${matchedRows.map((r) => r.rowNumber).join(", ")} but none carry a load ID`,
    };
  }
  if (loadKeys.size > 1) {
    return {
      found: false,
      reason: "MULTIPLE_ACTIVE_LOADS",
      detail: `VIN ${targetVin} appears on multiple active worksheet/load pairs; cannot attribute freight`,
    };
  }
  const loadKey = [...loadKeys][0]!;
  const separator = loadKey.indexOf("\u0000");
  const worksheetName = loadKey.slice(0, separator) || undefined;
  const loadId = loadKey.slice(separator + 1);

  const loadRows = activeRows.filter(
    (row) =>
      (row.worksheetName ?? "") === (worksheetName ?? "") &&
      normalizeLoadId(row.loadId) === loadId,
  );

  const distinctVins = new Set<string>();
  for (const row of loadRows) {
    if (row.vin === null || row.vin === undefined) continue;
    const vin = normalizeVin(String(row.vin));
    if (vin) distinctVins.add(vin);
  }

  const prices = new Set<number>();
  for (const row of loadRows) {
    const price = parseMoney(row.loadPrice);
    if (price !== null && price > 0) prices.add(price);
  }
  if (prices.size === 0) {
    return {
      found: false,
      reason: "NO_LOAD_PRICE",
      detail: `Load ${loadId} has no usable load price`,
    };
  }
  if (prices.size > 1) {
    return {
      found: false,
      reason: "AMBIGUOUS_LOAD_PRICE",
      detail: `Load ${loadId} carries conflicting prices (${[...prices].join(", ")}); refusing to guess`,
    };
  }
  const loadPrice = [...prices][0]!;

  const amount = roundToCents(loadPrice / distinctVins.size);
  return {
    found: true,
    amount,
    evidence: {
      worksheetName,
      loadId,
      loadPrice,
      distinctVinCount: distinctVins.size,
      vins: [...distinctVins].sort(),
      matchedRowNumbers: matchedRows.map((r) => r.rowNumber),
      loadRowNumbers: loadRows.map((r) => r.rowNumber),
    },
  };
}
