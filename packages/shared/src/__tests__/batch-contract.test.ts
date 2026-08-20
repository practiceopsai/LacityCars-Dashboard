import { describe, expect, it } from "vitest";
import {
  BatchIntakeRequestSchema,
  ExistingBatchRequestSchema,
  HermesBatchTriggerPayloadSchema,
} from "../contracts";

const vehicles = [
  { store: "LA", vin: "1HGCM82633A004352", model: "Accord" },
  { store: "Columbia", vin: "1M8GDM9AXKP042788", model: "Bus" },
];

describe("batch contracts", () => {
  it("accepts a mixed-store transport group with one UTC schedule", () => {
    expect(
      BatchIntakeRequestSchema.parse({
        name: "Load 42",
        transportReference: "42",
        scheduledAt: "2026-08-21T23:00:00.000Z",
        vehicles,
      }).vehicles,
    ).toHaveLength(2);
  });

  it("requires at least two vehicles", () => {
    expect(
      BatchIntakeRequestSchema.safeParse({
        name: "Not a batch",
        scheduledAt: "2026-08-21T23:00:00.000Z",
        vehicles: vehicles.slice(0, 1),
      }).success,
    ).toBe(false);
  });

  it("accepts an ordered set of already-ready vehicle IDs", () => {
    const parsed = ExistingBatchRequestSchema.parse({
      name: "LA ready continuation",
      vehicleIds: ["vehicle-2", "vehicle-1"],
    });
    expect(parsed.vehicleIds).toEqual(["vehicle-2", "vehicle-1"]);
  });

  it("requires a child request ID and freight evidence for every dispatched VIN", () => {
    const base = {
      request_id: "batch-1:2",
      callback_url: "https://api.example.com/api/webhooks/hermes",
      batch: { id: "batch-1", group_key: "group-1", name: "Load 42", transport_reference: "42" },
      schedule: { starts_at: "2026-08-21T23:00:00.000Z", eastern: "7 PM EDT", pacific: "4 PM PDT" },
      store: {
        code: "LA_CITY",
        name: "LA City",
        autosoft_instance: "LA City Cars",
        stock_prefix: "L",
        internal_charges: [{ label: "Pack", amount: 55 }],
        charges_total: 55,
      },
      vehicles: [{
        request_id: "batch-1:2:1:vehicle-1",
        vin: "1HGCM82633A004352",
        model: "Accord",
        stock_number: null,
        freight: { amount: 100, evidence: { loadId: "42" } },
        corrections: [],
      }],
    };
    expect(HermesBatchTriggerPayloadSchema.safeParse(base).success).toBe(true);
    expect(
      HermesBatchTriggerPayloadSchema.safeParse({
        ...base,
        vehicles: [{ ...base.vehicles[0], request_id: undefined }],
      }).success,
    ).toBe(false);
  });
});
