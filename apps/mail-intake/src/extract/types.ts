/** One vehicle row as extracted from an emailed document, before validation. */
export interface ExtractedRow {
  vin: string;
  model: string | null;
  store: string | null;
  source: string | null;
  stockNumber: string | null;
  /** Where the row came from, for the reply email ("Sheet1 row 4", "PDF page 2"). */
  origin: string;
}

export interface ExtractionResult {
  rows: ExtractedRow[];
  warnings: string[];
}
