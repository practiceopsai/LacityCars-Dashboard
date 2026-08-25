import { EASTERN_TIME_ZONE, zonedLocalToIso } from "@lacity/shared";

export const STOCKING_HOUR_ET = 19;

function easternParts(date: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The operating rule: automated stocking runs start at or after 7:00 PM Eastern.
 * Returns the next 7 PM ET boundary as a UTC ISO string — today if the Eastern
 * clock has not reached 19:00 yet, otherwise tomorrow.
 */
export function nextStockingWindowIso(now: Date = new Date()): string {
  const today = easternParts(now);
  const todayLocal = `${today.year}-${pad(today.month)}-${pad(today.day)}T${pad(STOCKING_HOUR_ET)}:00`;
  if (today.hour < STOCKING_HOUR_ET) {
    return zonedLocalToIso(todayLocal, EASTERN_TIME_ZONE);
  }
  // Roll to tomorrow in Eastern terms by adding a day to the UTC instant and
  // re-reading the Eastern calendar date (correct across month/DST boundaries).
  const tomorrow = easternParts(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const tomorrowLocal = `${tomorrow.year}-${pad(tomorrow.month)}-${pad(tomorrow.day)}T${pad(STOCKING_HOUR_ET)}:00`;
  return zonedLocalToIso(tomorrowLocal, EASTERN_TIME_ZONE);
}
