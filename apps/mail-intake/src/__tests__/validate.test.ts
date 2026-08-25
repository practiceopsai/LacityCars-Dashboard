import { describe, expect, it } from "vitest";
import type { ExtractedRow } from "../extract/types";
import { findStoreInText, resolveStoreCode, validateRows } from "../validate";

const SCHEDULED = "2099-01-01T00:00:00.000Z";

const row = (overrides: Partial<ExtractedRow>): ExtractedRow => ({
  vin: "2HGFE2F59NH503265",
  model: "2022 Honda Civic Sport",
  store: null,
  source: null,
  stockNumber: null,
  origin: "test row",
  ...overrides,
});

describe("resolveStoreCode / findStoreInText", () => {
  it("resolves aliases case-insensitively", () => {
    expect(resolveStoreCode("LA CITY CARS")).toBe("LA_CITY");
    expect(resolveStoreCode("la")).toBe("LA_CITY");
    expect(resolveStoreCode("Columbia")).toBe("COLUMBIA_CITY");
    expect(resolveStoreCode("miami")).toBeNull();
  });

  it("finds a single store mention in free text", () => {
    expect(findStoreInText("Cars to stock for LA City tonight")).toBe("LA_CITY");
    expect(findStoreInText("Columbia city cars — new arrivals")).toBe("COLUMBIA_CITY");
  });

  it("refuses to guess when both stores are mentioned or none are", () => {
    expect(findStoreInText("LA City and Columbia City vehicles attached")).toBeNull();
    expect(findStoreInText("vehicles attached")).toBeNull();
  });
});

describe("validateRows", () => {
  it("passes a clean row and carries source/stock through", () => {
    const outcome = validateRows(
      [row({ store: "LA City Cars", source: "Manheim SoCal", stockNumber: "L12999" })],
      null,
      SCHEDULED,
    );
    expect(outcome.problems).toHaveLength(0);
    expect(outcome.clean[0]).toMatchObject({
      store: "LA_CITY",
      vin: "2HGFE2F59NH503265",
      source: "Manheim SoCal",
      stockNumber: "L12999",
      scheduledAt: SCHEDULED,
    });
  });

  it("uses the subject/body fallback store when the row has none", () => {
    const outcome = validateRows([row({})], "COLUMBIA_CITY", SCHEDULED);
    expect(outcome.clean[0]!.store).toBe("COLUMBIA_CITY");
  });

  it("bounces a bad check digit instead of queueing it", () => {
    const outcome = validateRows([row({ vin: "2HGFE2F58NH503265" })], "LA_CITY", SCHEDULED);
    expect(outcome.clean).toHaveLength(0);
    expect(outcome.problems[0]!.reasons.join(" ")).toContain("check digit");
  });

  it("bounces when no store is resolvable anywhere", () => {
    const outcome = validateRows([row({})], null, SCHEDULED);
    expect(outcome.clean).toHaveLength(0);
    expect(outcome.problems[0]!.reasons.join(" ")).toContain("No store");
  });

  it("bounces an unknown per-row store even with a fallback available", () => {
    const outcome = validateRows([row({ store: "Miami" })], "LA_CITY", SCHEDULED);
    expect(outcome.clean).toHaveLength(0);
    expect(outcome.problems[0]!.reasons.join(" ")).toContain('Unknown store "Miami"');
  });

  it("bounces a VIN repeated within the same email", () => {
    const outcome = validateRows([row({}), row({ origin: "second copy" })], "LA_CITY", SCHEDULED);
    expect(outcome.clean).toHaveLength(1);
    expect(outcome.problems[0]!.reasons.join(" ")).toContain("Duplicate VIN within the same email");
  });

  it("bounces a missing model", () => {
    const outcome = validateRows([row({ model: null })], "LA_CITY", SCHEDULED);
    expect(outcome.problems[0]!.reasons.join(" ")).toContain("No model");
  });
});
