import { describe, expect, it, vi } from "vitest";
import {
  enqueueFreightCheck,
  enqueueHermesDispatch,
  freightJobId,
  hermesJobId,
  type Queues,
} from "../services/queues";

function mockQueues() {
  return {
    freight: { add: vi.fn().mockResolvedValue(undefined) },
    hermes: { add: vi.fn().mockResolvedValue(undefined) },
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queues;
}

describe("queue job IDs", () => {
  const vehicleId = "b64caa6e-08d3-45ee-8180-6dc08d8c346a";

  it("builds BullMQ-safe, distinct freight IDs", () => {
    expect(freightJobId(vehicleId, 0, 0)).toBe(`freight-${vehicleId}-0-0`);
    expect(freightJobId(vehicleId, 0, 0)).not.toContain(":");
    expect(freightJobId(vehicleId, 1, 0)).not.toBe(freightJobId(vehicleId, 0, 0));
    expect(freightJobId(vehicleId, 0, 1)).not.toBe(freightJobId(vehicleId, 0, 0));
  });

  it("builds BullMQ-safe, distinct Hermes IDs", () => {
    expect(hermesJobId(vehicleId, 0)).toBe(`hermes-${vehicleId}-0`);
    expect(hermesJobId(vehicleId, 0)).not.toContain(":");
    expect(hermesJobId(vehicleId, 1)).not.toBe(hermesJobId(vehicleId, 0));
  });

  it("passes the safe freight ID to BullMQ", async () => {
    const queues = mockQueues();
    await enqueueFreightCheck(queues, vehicleId, { nonce: 2, attempt: 3 });
    expect(queues.freight.add).toHaveBeenCalledWith(
      "check",
      { vehicleId, nonce: 2, attempt: 3 },
      expect.objectContaining({ jobId: `freight-${vehicleId}-2-3` }),
    );
  });

  it("passes the safe Hermes ID to BullMQ", async () => {
    const queues = mockQueues();
    await enqueueHermesDispatch(queues, vehicleId, 4);
    expect(queues.hermes.add).toHaveBeenCalledWith(
      "dispatch",
      { vehicleId, nonce: 4 },
      expect.objectContaining({ jobId: `hermes-${vehicleId}-4` }),
    );
  });

  it("delays Hermes until the scheduled boundary", async () => {
    const queues = mockQueues();
    const scheduled = new Date(Date.now() + 60_000);
    await enqueueHermesDispatch(queues, vehicleId, 5, scheduled);
    expect(queues.hermes.add).toHaveBeenCalledWith(
      "dispatch",
      { vehicleId, nonce: 5 },
      expect.objectContaining({ delay: expect.any(Number) }),
    );
    const options = vi.mocked(queues.hermes.add).mock.calls[0]![2]!;
    expect(options.delay).toBeGreaterThan(50_000);
  });
});
