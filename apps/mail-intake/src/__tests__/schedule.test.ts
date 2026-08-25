import { describe, expect, it } from "vitest";
import { nextStockingWindowIso } from "../schedule";

describe("nextStockingWindowIso", () => {
  it("targets today 7 PM ET when the Eastern clock is before 19:00 (EDT)", () => {
    // 2026-08-25 14:00Z = 10:00 AM EDT.
    expect(nextStockingWindowIso(new Date("2026-08-25T14:00:00Z"))).toBe(
      "2026-08-25T23:00:00.000Z",
    );
  });

  it("rolls to tomorrow 7 PM ET once the Eastern clock passes 19:00", () => {
    // 2026-08-25 23:30Z = 7:30 PM EDT.
    expect(nextStockingWindowIso(new Date("2026-08-25T23:30:00Z"))).toBe(
      "2026-08-26T23:00:00.000Z",
    );
  });

  it("uses the EST offset in winter (7 PM ET = 00:00Z next day)", () => {
    // 2026-12-01 15:00Z = 10:00 AM EST.
    expect(nextStockingWindowIso(new Date("2026-12-01T15:00:00Z"))).toBe(
      "2026-12-02T00:00:00.000Z",
    );
  });

  it("handles the late-UTC-evening edge where UTC has rolled but ET has not", () => {
    // 2026-08-26 01:00Z = Aug 25, 9:00 PM EDT → next window is Aug 26 7 PM EDT.
    expect(nextStockingWindowIso(new Date("2026-08-26T01:00:00Z"))).toBe(
      "2026-08-26T23:00:00.000Z",
    );
  });
});
