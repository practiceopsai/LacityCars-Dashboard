/** One data row extracted from the dispatch workbook. Values are raw cell contents. */
export interface DispatchRow {
  /** Source worksheet; absent only for legacy/programmatically supplied rows. */
  worksheetName?: string;
  /** 1-based row number in the worksheet, for evidence/audit. */
  rowNumber: number;
  vin: unknown;
  loadId: unknown;
  loadPrice: unknown;
  status?: unknown;
}

export interface FreightEvidence {
  /** Worksheet containing the matched load. */
  worksheetName?: string;
  loadId: string;
  loadPrice: number;
  distinctVinCount: number;
  /** Normalized VINs sharing the load (the divisor set). */
  vins: string[];
  /** Worksheet rows that matched the target VIN. */
  matchedRowNumbers: number[];
  /** Worksheet rows that made up the load. */
  loadRowNumbers: number[];
}

export type FreightMissReason =
  | "VIN_NOT_FOUND"
  | "NO_ACTIVE_LOAD"
  | "MULTIPLE_ACTIVE_LOADS"
  | "NO_LOAD_PRICE"
  | "AMBIGUOUS_LOAD_PRICE";

export type FreightResult =
  | { found: true; amount: number; evidence: FreightEvidence }
  | { found: false; reason: FreightMissReason; detail: string };
