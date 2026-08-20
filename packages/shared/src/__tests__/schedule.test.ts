import { describe, expect, it } from "vitest";
import {
  EASTERN_TIME_ZONE,
  PACIFIC_TIME_ZONE,
  stockingScheduleLabels,
  zonedLocalToIso,
} from "../schedule";

describe("stocking schedule time zones", () => {
  it("converts summer Eastern time to UTC and displays both zones", () => {
    const iso = zonedLocalToIso("2026-08-20T19:00", EASTERN_TIME_ZONE);
    expect(iso).toBe("2026-08-20T23:00:00.000Z");
    const labels = stockingScheduleLabels(iso);
    expect(labels.eastern).toContain("7:00 PM");
    expect(labels.eastern).toContain("EDT");
    expect(labels.pacific).toContain("4:00 PM");
    expect(labels.pacific).toContain("PDT");
  });

  it("converts winter Pacific time with standard-time offsets", () => {
    expect(zonedLocalToIso("2026-12-20T16:00", PACIFIC_TIME_ZONE)).toBe(
      "2026-12-21T00:00:00.000Z",
    );
  });

  it("rejects a nonexistent daylight-saving wall-clock time", () => {
    expect(() => zonedLocalToIso("2026-03-08T02:30", EASTERN_TIME_ZONE)).toThrow(
      /does not exist/,
    );
  });
});
