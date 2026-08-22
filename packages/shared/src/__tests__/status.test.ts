import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  hermesStatusToVehicleStatus,
  InvalidTransitionError,
  isVehicleStatus,
  RETRYABLE_STATUSES,
  VEHICLE_STATUSES,
} from "../status";

describe("state machine", () => {
  it("declares all seven canonical statuses", () => {
    expect(VEHICLE_STATUSES).toEqual([
      "PENDING",
      "AWAITING_FREIGHT",
      "READY",
      "PROCESSING",
      "ACTION_REQUIRED",
      "COMPLETED",
      "FAILED",
    ]);
  });

  it("allows the happy path PENDING -> READY -> PROCESSING -> COMPLETED", () => {
    expect(canTransition("PENDING", "READY")).toBe(true);
    expect(canTransition("READY", "PROCESSING")).toBe(true);
    expect(canTransition("PROCESSING", "COMPLETED")).toBe(true);
  });

  it("allows the freight-miss path PENDING -> AWAITING_FREIGHT -> READY", () => {
    expect(canTransition("PENDING", "AWAITING_FREIGHT")).toBe(true);
    expect(canTransition("AWAITING_FREIGHT", "AWAITING_FREIGHT")).toBe(true); // retry tick
    expect(canTransition("AWAITING_FREIGHT", "READY")).toBe(true);
  });

  it("allows out-of-order COMPLETED directly from READY", () => {
    expect(canTransition("READY", "COMPLETED")).toBe(true);
  });

  it("treats repeated PROCESSING callbacks as idempotent", () => {
    expect(canTransition("PROCESSING", "PROCESSING")).toBe(true);
  });

  it("makes COMPLETED terminal", () => {
    expect(ALLOWED_TRANSITIONS.COMPLETED).toHaveLength(0);
    for (const to of VEHICLE_STATUSES) {
      expect(canTransition("COMPLETED", to)).toBe(false);
    }
  });

  it("forbids skipping backwards from COMPLETED or into PENDING", () => {
    for (const from of VEHICLE_STATUSES) {
      expect(canTransition(from, "PENDING")).toBe(false);
    }
  });

  it("supports operator retry from FAILED and ACTION_REQUIRED", () => {
    expect(canTransition("FAILED", "AWAITING_FREIGHT")).toBe(true);
    expect(canTransition("FAILED", "READY")).toBe(true);
    expect(canTransition("FAILED", "COMPLETED")).toBe(true);
    expect(canTransition("ACTION_REQUIRED", "AWAITING_FREIGHT")).toBe(true);
    expect(canTransition("ACTION_REQUIRED", "READY")).toBe(true);
    expect(RETRYABLE_STATUSES).toContain("FAILED");
    expect(RETRYABLE_STATUSES).toContain("ACTION_REQUIRED");
    expect(RETRYABLE_STATUSES).not.toContain("COMPLETED");
    expect(RETRYABLE_STATUSES).not.toContain("PROCESSING");
  });

  it("assertTransition throws a typed error on violations", () => {
    expect(() => assertTransition("COMPLETED", "PROCESSING")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("READY", "PROCESSING")).not.toThrow();
  });

  it("maps Hermes callback statuses onto vehicle statuses", () => {
    expect(hermesStatusToVehicleStatus("PROCESSING")).toBe("PROCESSING");
    expect(hermesStatusToVehicleStatus("COMPLETED")).toBe("COMPLETED");
    expect(hermesStatusToVehicleStatus("FAILED")).toBe("FAILED");
  });

  it("type-guards status strings", () => {
    expect(isVehicleStatus("READY")).toBe(true);
    expect(isVehicleStatus("banana")).toBe(false);
  });
});
