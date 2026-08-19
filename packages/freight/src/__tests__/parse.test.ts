import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { calculateFreight } from "../calculate";
import { parseDispatchWorkbook, resolveColumns, WorkbookParseError } from "../parse";

const VIN_A = "1HGCM82633A004352";
const VIN_B = "2HGCM82633A004353";

async function buildWorkbook(rows: unknown[][], sheetName = "Dispatch"): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const r of rows) sheet.addRow(r);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("resolveColumns", () => {
  it("resolves by header name regardless of column order", () => {
    const cols = resolveColumns(["Status", "Load Price", "VIN #", "Load ID"]);
    expect(cols).toEqual({ status: 0, loadPrice: 1, vin: 2, loadId: 3 });
  });

  it("accepts common header variants", () => {
    expect(resolveColumns(["Vin Number", "Load #", "Freight", "Status"])).not.toBeNull();
    expect(resolveColumns(["VIN", "Load", "Price"])).not.toBeNull();
  });

  it("returns null when required columns are missing", () => {
    expect(resolveColumns(["VIN", "Model", "Color"])).toBeNull();
    expect(resolveColumns(["Load ID", "Price"])).toBeNull();
  });
});

describe("parseDispatchWorkbook", () => {
  it("round-trips an ExcelJS workbook into rows the calculator accepts", async () => {
    const buffer = await buildWorkbook([
      ["Dispatch Report — week of 8/17"], // preamble row before the header
      ["VIN", "Load ID", "Load Price", "Status"],
      [VIN_A, "LD-500", 1200, "Dispatched"],
      [VIN_B, "LD-500", 1200, "Dispatched"],
    ]);
    const rows = await parseDispatchWorkbook(buffer);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.rowNumber).toBe(3);

    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.amount).toBe(600);
  });

  it("preserves numeric load IDs for scientific-notation normalization", async () => {
    const buffer = await buildWorkbook([
      ["VIN", "Load ID", "Load Price", "Status"],
      [VIN_A, 123456789012, 500, "Dispatched"],
      [VIN_B, "1.23456789012E+11", 500, "Dispatched"],
    ]);
    const rows = await parseDispatchWorkbook(buffer);
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.evidence.loadId).toBe("123456789012");
    expect(result.evidence.distinctVinCount).toBe(2);
  });

  it("throws a typed error when no header row exists", async () => {
    const buffer = await buildWorkbook([
      ["Just", "Random", "Columns"],
      ["a", "b", "c"],
    ]);
    await expect(parseDispatchWorkbook(buffer)).rejects.toThrow(WorkbookParseError);
  });
});
