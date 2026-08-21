const DAY_MS = 24 * 60 * 60 * 1000;
const EASTERN_TIME_ZONE = "America/New_York";
const SWEEP_HOURS = [8, 20] as const;

/**
 * A freight match must never launch AutoSoft outside the operator-designated
 * shared-account window. Preserve a future appointment; if it has passed,
 * advance the same UTC clock time by whole days until it is future again.
 */
export function nextStockingWindow(
  scheduledStartAt: Date | null | undefined,
  now = new Date(),
): Date | null {
  if (!scheduledStartAt) return null;
  if (scheduledStartAt.getTime() > now.getTime()) return scheduledStartAt;
  const daysToAdvance = Math.floor((now.getTime() - scheduledStartAt.getTime()) / DAY_MS) + 1;
  return new Date(scheduledStartAt.getTime() + daysToAdvance * DAY_MS);
}

function easternParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function easternWallClockToUtc(year: number, month: number, day: number, hour: number): Date {
  const wallClockUtc = Date.UTC(year, month - 1, day, hour);
  let candidate = new Date(wallClockUtc);
  for (let i = 0; i < 3; i += 1) {
    const observed = easternParts(candidate);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    candidate = new Date(candidate.getTime() + wallClockUtc - observedAsUtc);
  }
  return candidate;
}

/** Exact next 8 AM / 8 PM Eastern check shown on waiting vehicle cards. */
export function nextFreightSweepHint(now = new Date()): Date {
  const local = easternParts(now);
  const nextHour = SWEEP_HOURS.find(
    (hour) => hour > local.hour || (hour === local.hour && (local.minute > 0 || local.second > 0)),
  );
  if (nextHour !== undefined) {
    return easternWallClockToUtc(local.year, local.month, local.day, nextHour);
  }
  const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return easternWallClockToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    SWEEP_HOURS[0],
  );
}
