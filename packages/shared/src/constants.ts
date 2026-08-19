/** BullMQ queue names. */
export const FREIGHT_QUEUE = "freight-check";
export const HERMES_QUEUE = "hermes-dispatch";

/** Redis pub/sub channel carrying vehicle update notifications for SSE. */
export const VEHICLE_UPDATES_CHANNEL = "lacity:vehicle-updates";

/** Operator session cookie. httpOnly + SameSite=Lax; set only by the API. */
export const SESSION_COOKIE = "lacity_session";

/** Header required on mutating requests as a CSRF defense-in-depth check. */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_VALUE = "fetch";

/** Hermes webhook headers. */
export const HERMES_SIGNATURE_HEADER = "x-hermes-signature";
export const HERMES_DELIVERY_HEADER = "x-hermes-delivery";

/** Freight retry policy defaults (overridable via env). */
export const DEFAULT_FREIGHT_MAX_ATTEMPTS = 20;
export const DEFAULT_FREIGHT_BACKOFF_BASE_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_FREIGHT_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Exponential backoff: base * 2^(attempt-1), capped. attempt is 1-based. */
export function freightBackoffMs(
  attempt: number,
  baseMs = DEFAULT_FREIGHT_BACKOFF_BASE_MS,
  maxMs = DEFAULT_FREIGHT_BACKOFF_MAX_MS,
): number {
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exp, maxMs);
}

export interface VehicleUpdateMessage {
  vehicleId: string;
  vin: string;
  status: string;
  storeCode: string;
  updatedAt: string;
}
