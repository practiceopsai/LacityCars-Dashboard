/**
 * Canonical workflow state machine.
 *
 * Semantics:
 * - PENDING          intake accepted, first freight verification queued
 * - AWAITING_FREIGHT VIN not on the dispatch workbook yet; retrying on backoff
 * - READY            freight defensible; Hermes dispatch queued/being sent
 * - PROCESSING       Hermes reported it is working the vehicle
 * - ACTION_REQUIRED  system needs operator input (e.g. freight retries exhausted)
 * - COMPLETED        Hermes finished accounting; terminal
 * - FAILED           Hermes run failed; operator may correct and retry
 */

export const VEHICLE_STATUSES = [
  "PENDING",
  "AWAITING_FREIGHT",
  "READY",
  "PROCESSING",
  "ACTION_REQUIRED",
  "COMPLETED",
  "FAILED",
] as const;

export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const ALLOWED_TRANSITIONS: Record<VehicleStatus, readonly VehicleStatus[]> = {
  PENDING: ["AWAITING_FREIGHT", "READY", "ACTION_REQUIRED", "FAILED"],
  // Self-transition = a retry tick that found nothing (updates nextFreightCheckAt).
  AWAITING_FREIGHT: ["AWAITING_FREIGHT", "READY", "ACTION_REQUIRED", "FAILED"],
  // READY -> COMPLETED covers out-of-order callbacks (COMPLETED arriving before PROCESSING).
  READY: ["PROCESSING", "COMPLETED", "ACTION_REQUIRED", "FAILED"],
  // Self-transition = idempotent PROCESSING progress callbacks.
  PROCESSING: ["PROCESSING", "COMPLETED", "ACTION_REQUIRED", "FAILED"],
  ACTION_REQUIRED: ["AWAITING_FREIGHT", "READY", "FAILED"],
  // FAILED -> COMPLETED reconciles a late, signed terminal callback after the
  // live AutoSoft post succeeded but a timeout/store-wide failure marked the
  // dashboard stale. The HMAC callback remains the required evidence path.
  FAILED: ["AWAITING_FREIGHT", "READY", "COMPLETED"],
  COMPLETED: [],
};

/** Statuses an operator may requeue via the Retry endpoint. */
export const RETRYABLE_STATUSES: readonly VehicleStatus[] = [
  "ACTION_REQUIRED",
  "FAILED",
  "AWAITING_FREIGHT",
];

/** Statuses considered "active" for Store+VIN intake idempotency. */
export const ACTIVE_STATUSES: readonly VehicleStatus[] = [
  "PENDING",
  "AWAITING_FREIGHT",
  "READY",
  "PROCESSING",
  "ACTION_REQUIRED",
  "FAILED",
];

export function isVehicleStatus(value: string): value is VehicleStatus {
  return (VEHICLE_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: VehicleStatus, to: VehicleStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: VehicleStatus,
    public readonly to: VehicleStatus,
  ) {
    super(`Invalid vehicle state transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: VehicleStatus, to: VehicleStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Map a Hermes callback status onto the vehicle state machine. */
export function hermesStatusToVehicleStatus(
  hermes: "PROCESSING" | "COMPLETED" | "FAILED",
): VehicleStatus {
  return hermes;
}
