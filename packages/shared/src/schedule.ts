export const EASTERN_TIME_ZONE = "America/New_York";
export const PACIFIC_TIME_ZONE = "America/Los_Angeles";

export type StockingTimeZone = typeof EASTERN_TIME_ZONE | typeof PACIFIC_TIME_ZONE;

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(date: Date, timeZone: StockingTimeZone): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
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

function sameParts(a: DateParts, b: DateParts): boolean {
  return Object.keys(a).every((key) => a[key as keyof DateParts] === b[key as keyof DateParts]);
}

/** Convert an HTML datetime-local value in an explicit IANA zone to UTC. */
export function zonedLocalToIso(value: string, timeZone: StockingTimeZone): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error("Use a valid date and time");
  const desired: DateParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const wallClockUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second,
  );

  // Iterate because the initial UTC guess can sit on the other side of a DST boundary.
  let candidate = new Date(wallClockUtc);
  for (let i = 0; i < 3; i++) {
    const observed = partsInZone(candidate, timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    candidate = new Date(candidate.getTime() + (wallClockUtc - observedAsUtc));
  }
  if (!sameParts(partsInZone(candidate, timeZone), desired)) {
    throw new Error("That local time does not exist because of daylight saving time");
  }
  return candidate.toISOString();
}

export function formatStockingTime(
  value: string | Date,
  timeZone: StockingTimeZone,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid schedule";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function stockingScheduleLabels(value: string | Date) {
  return {
    eastern: formatStockingTime(value, EASTERN_TIME_ZONE),
    pacific: formatStockingTime(value, PACIFIC_TIME_ZONE),
  };
}
