import ExcelJS from "exceljs";
import type { ExtractedRow, ExtractionResult } from "./types";

/**
 * Deterministic extraction from staff spreadsheets (.xlsx/.csv).
 * Column resolution is strictly by header NAME, never fixed letters — the same
 * discipline as packages/freight/src/parse.ts. Only a VIN column is required;
 * model/store/source/stock are optional and fall back to email-level context.
 */
const HEADER_MATCHERS: Record<"vin" | "model" | "store" | "source" | "stock", RegExp[]> = {
  vin: [/^vin\s*(#|no\.?|number)?$/i, /\bvin\b/i],
  model: [/^(vehicle|model|description|car)$/i, /\b(vehicle|model|description)\b/i],
  store: [/^(store|location|dealer(ship)?|lot)$/i, /\bstore\b/i],
  source: [/^(source|auction|purchased?\s*(from|at)?|seller)$/i, /\b(source|auction|seller)\b/i],
  stock: [/^stock\s*(#|no\.?|number)?$/i, /\bstock\b/i],
};

interface ResolvedColumns {
  vin: number;
  model?: number;
  store?: number;
  source?: number;
  stock?: number;
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

export function resolveVehicleColumns(
  headerCells: Array<string | null | undefined>,
): ResolvedColumns | null {
  const headers = headerCells.map((h) => (h ?? "").trim());
  const taken = new Set<number>();

  const vin = matchColumn(headers, HEADER_MATCHERS.vin, taken);
  if (vin === undefined) return null;
  taken.add(vin);

  const claim = (patterns: RegExp[]): number | undefined => {
    const index = matchColumn(headers, patterns, taken);
    if (index !== undefined) taken.add(index);
    return index;
  };
  return {
    vin,
    model: claim(HEADER_MATCHERS.model),
    store: claim(HEADER_MATCHERS.store),
    source: claim(HEADER_MATCHERS.source),
    stock: claim(HEADER_MATCHERS.stock),
  };
}

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

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class SpreadsheetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetParseError";
  }
}

async function loadWorkbook(buffer: Buffer, filename: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(filename);
  try {
    if (isCsv) {
      // ExcelJS's csv reader wants a stream; parsing from an in-memory string
      // avoids a temp file. A BOM confuses the header matcher, so strip it.
      const { Readable } = await import("node:stream");
      const content = buffer.toString("utf8").replace(/^﻿/, "");
      await workbook.csv.read(Readable.from([content]));
    } else {
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    }
  } catch (err) {
    throw new SpreadsheetParseError(
      `Could not read ${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return workbook;
}

/** Parse one spreadsheet attachment into extracted vehicle rows. */
export async function extractFromSpreadsheet(
  buffer: Buffer,
  filename: string,
): Promise<ExtractionResult> {
  const workbook = await loadWorkbook(buffer, filename);
  const rows: ExtractedRow[] = [];
  const warnings: string[] = [];
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
      columns = resolveVehicleColumns(cells);
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
      const vin = text(cellValue(row.getCell(resolved.vin + 1)));
      const read = (index: number | undefined): string | null =>
        index === undefined ? null : text(cellValue(row.getCell(index + 1)));
      const model = read(resolved.model);
      const store = read(resolved.store);
      const source = read(resolved.source);
      const stockNumber = read(resolved.stock);
      if (!vin && !model && !store) return; // spacer row
      if (!vin) {
        warnings.push(`${filename} ${worksheet.name} row ${rowNumber}: no VIN in a non-empty row`);
        return;
      }
      rows.push({
        vin,
        model,
        store,
        source,
        stockNumber,
        origin: `${filename} · ${worksheet.name} row ${rowNumber}`,
      });
    });
  }

  if (!locatedHeader) {
    throw new SpreadsheetParseError(
      `${filename}: could not locate a header row containing a VIN column`,
    );
  }
  return { rows, warnings };
}
