import { describe, expect, it, vi } from "vitest";
import {
  enqueueFreightCheck,
  enqueueHermesDispatch,
  AUTO_BATCH_SETTLE_MS,
  freightJobId,
  hermesJobId,
  type WorkerQueues,
} from "../queues";

function mockQueues() {
  return {
    freight: { add: vi.fn().mockResolvedValue(undefined) },
    hermes: { add: vi.fn().mockResolvedValue(undefined) },
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkerQueues;
}

describe("queue job IDs", () => {
  const vehicleId = "b64caa6e-08d3-45ee-8180-6dc08d8c346a";

  it("builds BullMQ-safe IDs", () => {
    expect(freightJobId(vehicleId, 0, 0)).toBe(`freight-${vehicleId}-0-0`);
    expect(hermesJobId(vehicleId, 0)).toBe(`hermes-${vehicleId}-0`);
    expect(freightJobId(vehicleId, 0, 0)).not.toContain(":");
    expect(hermesJobId(vehicleId, 0)).not.toContain(":");
  });

  it("keeps retry and dispatch cycles unique", () => {
    expect(freightJobId(vehicleId, 1, 0)).not.toBe(freightJobId(vehicleId, 0, 0));
    expect(freightJobId(vehicleId, 0, 1)).not.toBe(freightJobId(vehicleId, 0, 0));
    expect(hermesJobId(vehicleId, 1)).not.toBe(hermesJobId(vehicleId, 0));
  });

  it("passes safe IDs to both BullMQ queues", async () => {
    const queues = mockQueues();
    await enqueueFreightCheck(queues, vehicleId, { nonce: 2, attempt: 3 });
    await enqueueHermesDispatch(queues, vehicleId, 4);
    expect(queues.freight.add).toHaveBeenCalledWith(
      "check",
      { vehicleId, nonce: 2, attempt: 3 },
      expect.objectContaining({ jobId: `freight-${vehicleId}-2-3` }),
    );
    expect(queues.hermes.add).toHaveBeenCalledWith(
      "dispatch",
      { vehicleId, nonce: 4 },
      expect.objectContaining({ jobId: `hermes-${vehicleId}-4` }),
    );
    const options = vi.mocked(queues.hermes.add).mock.calls[0]![2]!;
    expect(options.delay).toBeGreaterThanOrEqual(AUTO_BATCH_SETTLE_MS - 1000);
  });
});
