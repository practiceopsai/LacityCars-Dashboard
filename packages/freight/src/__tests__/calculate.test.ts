import { describe, expect, it } from "vitest";
import { calculateFreight } from "../calculate";
import type { DispatchRow } from "../types";

const VIN_A = "1HGCM82633A004352";
const VIN_B = "2HGCM82633A004353";
const VIN_C = "3HGCM82633A004354";

function row(partial: Partial<DispatchRow> & { rowNumber: number }): DispatchRow {
  return { vin: null, loadId: null, loadPrice: null, status: "Dispatched", ...partial };
}

describe("calculateFreight", () => {
  it("splits the whole load price across distinct active VINs", () => {
    const rows = [
      row({ rowNumber: 2, vin: VIN_A, loadId: "LD-100", loadPrice: 900 }),
      row({ rowNumber: 3, vin: VIN_B, loadId: "LD-100", loadPrice: 900 }),
      row({ rowNumber: 4, vin: VIN_C, loadId: "LD-100", loadPrice: 900 }),
    ];
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.amount).toBe(300);
    expect(result.evidence.distinctVinCount).toBe(3);
    expect(result.evidence.loadId).toBe("LD-100");
    expect(result.evidence.loadPrice).toBe(900);
    expect(result.evidence.matchedRowNumbers).toEqual([2]);
  });

  it("counts duplicate VIN rows on a load only once", () => {
    const rows = [
      row({ rowNumber: 2, vin: VIN_A, loadId: "LD-1", loadPrice: 1000 }),
      row({ rowNumber: 3, vin: VIN_A, loadId: "LD-1", loadPrice: 1000 }), // duplicate row
      row({ rowNumber: 4, vin: VIN_B, loadId: "LD-1", loadPrice: 1000 }),
    ];
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.evidence.distinctVinCount).toBe(2);
    expect(result.amount).toBe(500);
  });

  it("excludes cancelled/void/declined rows from matching and from the divisor", () => {
    const rows = [
      row({ rowNumber: 2, vin: VIN_A, loadId: "LD-2", loadPrice: 800 }),
      row({ rowNumber: 3, vin: VIN_B, loadId: "LD-2", loadPrice: 800, status: "CANCELLED" }),
      row({ rowNumber: 4, vin: VIN_C, loadId: "LD-2", loadPrice: 800, status: "Voided" }),
    ];
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(true);
    if (!result.found) return;
    // Only VIN_A is active on the load, so it carries the whole price.
    expect(result.evidence.distinctVinCount).toBe(1);
    expect(result.amount).toBe(800);
  });

  it("does not match a VIN whose only rows are cancelled", () => {
    const rows = [row({ rowNumber: 2, vin: VIN_A, loadId: "LD-3", loadPrice: 500, status: "Declined" })];
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toBe("VIN_NOT_FOUND");
  });

  it("groups scientific-notation load IDs with their plain equivalents", () => {
    const rows = [
      row({ rowNumber: 2, vin: VIN_A, loadId: "1.23456789012E+11", loadPrice: 600 }),
      row({ rowNumber: 3, vin: VIN_B, loadId: "123456789012", loadPrice: 600 }),
      row({ rowNumber: 4, vin: VIN_C, loadId: 123456789012, loadPrice: 600 }),
    ];
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.evidence.loadId).toBe("123456789012");
    expect(result.evidence.distinctVinCount).toBe(3);
    expect(result.amount).toBe(200);
  });

  it("returns VIN_NOT_FOUND for absent VINs (never estimates)", () => {
    const rows = [row({ rowNumber: 2, vin: VIN_B, loadId: "LD-4", loadPrice: 700 })];
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toBe("VIN_NOT_FOUND");
  });

  it("matches on normalized VIN (case/whitespace/dashes)", () => {
    const rows = [
      row({ rowNumber: 2, vin: "1hgcm826-33a 004352", loadId: "LD-5", loadPrice: 400 }),
      row({ rowNumber: 3, vin: VIN_B, loadId: "LD-5", loadPrice: 400 }),
    ];
    const result = calculateFreight(rows, " 1HGCM82633A004352 ");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.amount).toBe(200);
  });

  it("refuses conflicting load prices", () => {
    const rows = [
      row({ rowNumber: 2, vin: VIN_A, loadId: "LD-6", loadPrice: 900 }),
      row({ rowNumber: 3, vin: VIN_B, loadId: "LD-6", loadPrice: 950 }),
    ];
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toBe("AMBIGUOUS_LOAD_PRICE");
  });

  it("refuses a VIN active on multiple loads", () => {
    const rows = [
      row({ rowNumber: 2, vin: VIN_A, loadId: "LD-7", loadPrice: 500 }),
      row({ rowNumber: 3, vin: VIN_A, loadId: "LD-8", loadPrice: 600 }),
    ];
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toBe("MULTIPLE_ACTIVE_LOADS");
  });

  it("reports rows with no load ID or no price distinctly", () => {
    const noLoad = calculateFreight([row({ rowNumber: 2, vin: VIN_A, loadPrice: 100 })], VIN_A);
    expect(noLoad.found).toBe(false);
    if (!noLoad.found) expect(noLoad.reason).toBe("NO_ACTIVE_LOAD");

    const noPrice = calculateFreight([row({ rowNumber: 2, vin: VIN_A, loadId: "LD-9" })], VIN_A);
    expect(noPrice.found).toBe(false);
    if (!noPrice.found) expect(noPrice.reason).toBe("NO_LOAD_PRICE");
  });

  it("parses money strings and rounds to cents", () => {
    const rows = [
      row({ rowNumber: 2, vin: VIN_A, loadId: "LD-10", loadPrice: "$1,000.00" }),
      row({ rowNumber: 3, vin: VIN_B, loadId: "LD-10", loadPrice: "$1,000.00" }),
      row({ rowNumber: 4, vin: VIN_C, loadId: "LD-10", loadPrice: 1000 }),
    ];
    const result = calculateFreight(rows, VIN_A);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.amount).toBe(333.33);
  });
});
