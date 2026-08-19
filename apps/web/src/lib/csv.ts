import { validateVin } from "@lacity/shared";

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

export interface CsvVehicleRow {
  rowNumber: number;
  store: string;
  vin: string;
  model: string;
  stockNumber?: string;
  errors: string[];
}

/**
 * Map CSV rows to intake candidates. Accepts a header row (store/vin/model/
 * stock columns by name, any order) or headerless rows in that order.
 */
export function mapCsvRows(rows: string[][]): CsvVehicleRow[] {
  if (rows.length === 0) return [];

  let dataRows = rows;
  let cols = { store: 0, vin: 1, model: 2, stock: 3 };
  const first = rows[0]!.map((c) => c.trim().toLowerCase());
  const vinIdx = first.findIndex((c) => c.includes("vin"));
  if (vinIdx >= 0) {
    const storeIdx = first.findIndex((c) => c.includes("store"));
    const modelIdx = first.findIndex((c) => c.includes("model"));
    const stockIdx = first.findIndex((c) => c.includes("stock"));
    cols = {
      store: storeIdx >= 0 ? storeIdx : 0,
      vin: vinIdx,
      model: modelIdx >= 0 ? modelIdx : 2,
      stock: stockIdx,
    };
    dataRows = rows.slice(1);
  }

  return dataRows.map((cells, i) => {
    const store = (cells[cols.store] ?? "").trim();
    const rawVin = (cells[cols.vin] ?? "").trim();
    const model = (cells[cols.model] ?? "").trim();
    const stockNumber = cols.stock >= 0 ? (cells[cols.stock] ?? "").trim() : "";
    const errors: string[] = [];
    if (!store) errors.push("Store is required");
    if (!model) errors.push("Model is required");
    const vinCheck = validateVin(rawVin);
    if (!vinCheck.ok) errors.push(...vinCheck.errors);
    return {
      rowNumber: i + 1,
      store,
      vin: vinCheck.vin ?? rawVin,
      model,
      stockNumber: stockNumber || undefined,
      errors,
    };
  });
}
