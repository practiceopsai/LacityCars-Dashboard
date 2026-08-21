import { describe, expect, it } from "vitest";
import { nextFreightSweepHint, nextStockingWindow } from "../freightSchedule";

describe("freight scheduling", () => {
  it("preserves a future operator stocking window", () => {
    const scheduled = new Date("2026-08-21T23:00:00.000Z");
    expect(nextStockingWindow(scheduled, new Date("2026-08-21T14:00:00.000Z"))).toEqual(scheduled);
  });

  it("advances a missed daily stocking window instead of dispatching immediately", () => {
    const scheduled = new Date("2026-08-20T23:00:00.000Z");
    expect(nextStockingWindow(scheduled, new Date("2026-08-21T14:00:00.000Z"))).toEqual(
      new Date("2026-08-21T23:00:00.000Z"),
    );
  });

  it("shows the next twice-daily check approximately twelve hours away", () => {
    expect(nextFreightSweepHint(new Date("2026-08-21T12:00:00.000Z"))).toEqual(
      new Date("2026-08-22T00:00:00.000Z"),
    );
  });
});
