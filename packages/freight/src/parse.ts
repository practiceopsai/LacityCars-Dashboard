import ExcelJS from "exceljs";
import type { DispatchRow } from "./types";

/**
 * Column resolution is strictly by header NAME, never by fixed letters.
 * First pattern list entry is the "exact" form; later entries are looser fallbacks.
 */
const HEADER_MATCHERS: Record<"vin" | "loadId" | "loadPrice" | "status", RegExp[]> = {
  vin: [/^vin\s*(#|no\.?|number)?$/i, /\bvin\b/i],
  loadId: [/^load\s*(id|#|no\.?|number)?$/i, /\bload\s*(id|#|no\.?|number)\b/i, /\bdispatch\s*(id|#)\b/i],
  loadPrice: [/^(load\s*)?(price|freight|cost|amount)$/i, /\b(price|freight|cost)\b/i],
  status: [/^status$/i, /\bstatus\b/i],
};

export interface ResolvedColumns {
  vin: number;
  loadId: number;
  loadPrice: number;
  status?: number;
}

function matchColumn(headers: string[], patterns: RegExp[], taken: Set<number>): number | undefined {
  for (const pattern of patterns) {
    for (let i = 0; i < headers.length; i++) {
      if (taken.has(i)) continue;
      const header = headers[i];
      if (header && pattern.test(header)) return i;
    }
  }
  return undefined;
}

/** Resolve required columns from a candidate header row, or null if it is not a header row. */
export function resolveColumns(headerCells: Array<string | null | undefined>): ResolvedColumns | null {
  const headers = headerCells.map((h) => (h ?? "").trim());
  const taken = new Set<number>();

  const vin = matchColumn(headers, HEADER_MATCHERS.vin, taken);
  if (vin === undefined) return null;
  taken.add(vin);

  const loadId = matchColumn(headers, HEADER_MATCHERS.loadId, taken);
  if (loadId === undefined) return null;
  taken.add(loadId);

  const loadPrice = matchColumn(headers, HEADER_MATCHERS.loadPrice, taken);
  if (loadPrice === undefined) return null;
  taken.add(loadPrice);

  const status = matchColumn(headers, HEADER_MATCHERS.status, taken);
  return { vin, loadId, loadPrice, status };
}

/** Extract a plain value from an ExcelJS cell (formula results, rich text, etc.). */
function cellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    if ("result" in value) return (value as ExcelJS.CellFormulaValue).result ?? null;
    if ("richText" in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map((rt) => rt.text).join("");
    }
    if ("text" in value) return (value as ExcelJS.CellHyperlinkValue).text;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  return value;
}

const HEADER_SCAN_ROWS = 10;

export class WorkbookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookParseError";
  }
}

/**
 * Parse a dispatch workbook (.xlsx) buffer into raw DispatchRows.
 * Scans every sheet's opening rows for a header row containing VIN, load ID,
 * and load price columns (by name), then reads every following row. Row numbers
 * remain local to their source worksheet for evidence/audit purposes.
 */
export async function parseDispatchWorkbook(buffer: Buffer | ArrayBuffer): Promise<DispatchRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS's typings predate Node's generic Buffer<ArrayBufferLike>.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (err) {
    throw new WorkbookParseError(
      `Could not read workbook: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rows: DispatchRow[] = [];
  let locatedHeader = false;

  for (const worksheet of workbook.worksheets) {
    let columns: ResolvedColumns | null = null;
    let headerRowNumber = 0;
    for (let r = 1; r <= Math.min(HEADER_SCAN_ROWS, worksheet.rowCount); r++) {
      const row = worksheet.getRow(r);
      const cells: Array<string | null> = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] =
          cell.value === null || cell.value === undefined ? null : String(cellValue(cell));
      });
      columns = resolveColumns(cells);
      if (columns) {
        headerRowNumber = r;
        locatedHeader = true;
        break;
      }
    }
    if (!columns || headerRowNumber === 0) continue;
    const resolved = columns;

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNumber) return;
      const vin = cellValue(row.getCell(resolved.vin + 1));
      const loadId = cellValue(row.getCell(resolved.loadId + 1));
      const loadPrice = cellValue(row.getCell(resolved.loadPrice + 1));
      const status =
        resolved.status !== undefined ? cellValue(row.getCell(resolved.status + 1)) : null;
      // Skip fully empty spacer rows.
      if (vin === null && loadId === null && loadPrice === null) return;
      rows.push({ worksheetName: worksheet.name, rowNumber, vin, loadId, loadPrice, status });
    });
  }

  if (!locatedHeader) {
    if (workbook.worksheets.length === 0) {
      throw new WorkbookParseError("Workbook contains no worksheets");
    }
    throw new WorkbookParseError(
      "Could not locate a header row with VIN, load ID, and load price columns",
    );
  }
  return rows;
}
