import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@lacity/database";
import type { WorkerConfig } from "../config";
import { createBatchFreightProcessor } from "../processors/batchFreightCheck";
import type { FreightJobData, WorkerQueues } from "../queues";

vi.mock("@lacity/database", () => ({ transitionVehicle: vi.fn() }));
vi.mock("@lacity/freight", () => ({ calculateFreight: vi.fn() }));
vi.mock("../workbookSource", () => ({
  loadDispatchWorkbookForBatch: vi.fn().mockResolvedValue({ rows: [], source: "dispatch.xlsx", fetchedAt: "2026-08-20T00:00:00.000Z" }),
  WorkbookSourceError: class WorkbookSourceError extends Error {},
}));
vi.mock("../publish", () => ({ publishVehicle: vi.fn() }));

import { transitionVehicle } from "@lacity/database";
import { calculateFreight } from "@lacity/freight";
import { loadDispatchWorkbookForBatch } from "../workbookSource";

const config = {
  FREIGHT_MAX_ATTEMPTS: 20,
  FREIGHT_BACKOFF_BASE_MS: 300_000,
  FREIGHT_BACKOFF_MAX_MS: 21_600_000,
} as WorkerConfig;

function makeJob(): Job<FreightJobData> {
  return { data: { batchId: "batch-1", nonce: 0, attempt: 0 } } as Job<FreightJobData>;
}

beforeEach(() => vi.clearAllMocks());

describe("batch freight check", () => {
  it("uses one fresh snapshot for all unresolved VINs and queues ready plus retry work", async () => {
    const vehicles = [
      { id: "veh-1", vin: "VIN1", status: "PENDING", freightAttempts: 0, store: {} },
      { id: "veh-2", vin: "VIN2", status: "PENDING", freightAttempts: 0, store: {} },
    ];
    const prisma = {
      stockingBatch: {
        findUnique: vi.fn().mockResolvedValue({
          id: "batch-1",
          status: "PREPARING",
          vehicles,
        }),
        update: vi.fn().mockResolvedValue({
          id: "batch-1",
          dispatchNonce: 1,
          scheduledStartAt: new Date("2026-08-21T23:00:00.000Z"),
        }),
      },
    };
    vi.mocked(calculateFreight)
      .mockReturnValueOnce({
        found: true,
        amount: 100,
        evidence: {
          loadId: "42",
          loadPrice: 200,
          distinctVinCount: 2,
          vins: ["VIN1", "VIN2"],
          matchedRowNumbers: [1],
          loadRowNumbers: [1, 2],
        },
      })
      .mockReturnValueOnce({ found: false, reason: "VIN_NOT_FOUND", detail: "not posted" });
    vi.mocked(transitionVehicle).mockImplementation(async (_prisma, id, status) => ({
      id,
      status,
      store: {},
    }) as never);
    const queues = {
      freight: { add: vi.fn().mockResolvedValue(undefined) },
      hermes: { add: vi.fn().mockResolvedValue(undefined) },
    } as unknown as WorkerQueues;
    const processor = createBatchFreightProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher: {} as Redis,
      queues,
    });

    await processor(makeJob());

    expect(loadDispatchWorkbookForBatch).toHaveBeenCalledOnce();
    expect(calculateFreight).toHaveBeenCalledTimes(2);
    expect(queues.hermes.add).toHaveBeenCalledOnce();
    expect(queues.freight.add).toHaveBeenCalledOnce();
  });
});
