import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { extractFromSpreadsheet, SpreadsheetParseError } from "../extract/spreadsheet";

/** Golden: the exact CSV format staff already send (store,vin,model,stock). */
const STAFF_CSV = `store,vin,model,stock
LA CITY CARS,2HGFE2F59NH503265,2022 Honda Civic Sport,
LA CITY CARS,5FNYF6H54KB097163,2019 Honda Pilot EX-L,
LA CITY CARS,JTDBVRBD7LA008206,2020 Toyota Mirai Base,
LA CITY CARS,5FPYK3F5XLB025602,2020 Honda Ridgeline RTL,
`;

describe("extractFromSpreadsheet", () => {
  it("parses the staff CSV format (golden)", async () => {
    const result = await extractFromSpreadsheet(Buffer.from(STAFF_CSV, "utf8"), "cars.csv");
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({
      vin: "2HGFE2F59NH503265",
      model: "2022 Honda Civic Sport",
      store: "LA CITY CARS",
      stockNumber: null,
      source: null,
    });
    expect(result.rows[3]!.vin).toBe("5FPYK3F5XLB025602");
    expect(result.warnings).toHaveLength(0);
  });

  it("parses a dealership-style sheet with DATE RECEIVED / VEHICLE / STOCK # / VIN headers", async () => {
    const csv = `DATE RECEIVED,VEHICLE,STOCK #,VIN
08/20/26,2024 Volkswagen Atlas,,1V2DR2CA3RC534210
08/24/26,2023 Volkswagen Tiguan,,3VVRB7AX7PM088298
`;
    const result = await extractFromSpreadsheet(Buffer.from(csv, "utf8"), "list.csv");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      vin: "1V2DR2CA3RC534210",
      model: "2024 Volkswagen Atlas",
      stockNumber: null,
    });
  });

  it("parses an xlsx with a source column and preamble rows above the header", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Cars");
    sheet.addRow(["Vehicles to stock this week"]);
    sheet.addRow([]);
    sheet.addRow(["VIN", "Model", "Store", "Auction"]);
    sheet.addRow(["2HGFE2F59NH503265", "2022 Honda Civic Sport", "LA City", "Manheim SoCal"]);
    sheet.addRow([]);
    sheet.addRow(["5FNYF6H54KB097163", "2019 Honda Pilot EX-L", "Columbia", "ADESA LA"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await extractFromSpreadsheet(buffer, "week.xlsx");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      vin: "2HGFE2F59NH503265",
      store: "LA City",
      source: "Manheim SoCal",
      origin: "week.xlsx · Cars row 4",
    });
    expect(result.rows[1]!.store).toBe("Columbia");
  });

  it("warns on rows with data but no VIN and skips spacer rows silently", async () => {
    const csv = `vin,model
2HGFE2F59NH503265,2022 Honda Civic Sport
,2019 Honda Pilot missing its vin
`;
    const result = await extractFromSpreadsheet(Buffer.from(csv, "utf8"), "gaps.csv");
    expect(result.rows).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("no VIN");
  });

  it("throws a typed error when no VIN header exists", async () => {
    const csv = `name,price
Civic,12000
`;
    await expect(extractFromSpreadsheet(Buffer.from(csv, "utf8"), "junk.csv")).rejects.toThrow(
      SpreadsheetParseError,
    );
  });
});
