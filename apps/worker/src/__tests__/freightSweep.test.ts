import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@lacity/database";
import type { WorkerConfig } from "../config";
import { createFreightSweepProcessor } from "../processors/freightSweep";
import type { FreightJobData, WorkerQueues } from "../queues";

vi.mock("@lacity/database", () => ({ transitionVehicle: vi.fn() }));
vi.mock("@lacity/freight", () => ({ calculateFreight: vi.fn() }));
vi.mock("../workbookSource", () => ({
  loadDispatchWorkbook: vi.fn().mockResolvedValue({
    rows: [],
    source: "dispatch.xlsx",
    fetchedAt: "2026-08-21T14:00:00.000Z",
  }),
  WorkbookSourceError: class WorkbookSourceError extends Error {},
}));
vi.mock("../publish", () => ({ publishVehicle: vi.fn() }));

import { transitionVehicle } from "@lacity/database";
import { calculateFreight } from "@lacity/freight";
import { loadDispatchWorkbook } from "../workbookSource";

const config = {} as WorkerConfig;
const job = { data: { sweep: true, nonce: 0, attempt: 0 } } as Job<FreightJobData>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-21T14:00:00.000Z"));
});

describe("twice-daily freight sweep", () => {
  it("uses one snapshot, promotes matches, rolls missed windows, and parks misses", async () => {
    const vehicles = [
      {
        id: "found",
        vin: "VIN-FOUND",
        status: "AWAITING_FREIGHT",
        freightAttempts: 9,
        dispatchNonce: 2,
        scheduledStartAt: new Date("2026-08-20T23:00:00.000Z"),
        stockingBatchId: null,
        stockingBatch: null,
        storeId: "la",
        store: { code: "LA_CITY" },
        createdAt: new Date(),
      },
      {
        id: "waiting",
        vin: "VIN-WAITING",
        status: "AWAITING_FREIGHT",
        freightAttempts: 9,
        dispatchNonce: 1,
        scheduledStartAt: new Date("2026-08-20T23:00:00.000Z"),
        stockingBatchId: null,
        stockingBatch: null,
        storeId: "columbia",
        store: { code: "COLUMBIA_CITY" },
        createdAt: new Date(),
      },
    ];
    const prisma = {
      vehicle: { findMany: vi.fn().mockResolvedValue(vehicles) },
      stockingBatch: { findUnique: vi.fn(), update: vi.fn() },
    };
    vi.mocked(calculateFreight)
      .mockReturnValueOnce({
        found: true,
        amount: 350,
        evidence: {
          loadId: "load-1",
          loadPrice: 700,
          distinctVinCount: 2,
          vins: ["VIN-FOUND", "OTHER"],
          matchedRowNumbers: [10],
          loadRowNumbers: [10, 11],
        },
      })
      .mockReturnValueOnce({ found: false, reason: "VIN_NOT_FOUND", detail: "not dispatched" });
    vi.mocked(transitionVehicle).mockImplementation(async (_prisma, id, status, options) => ({
      ...vehicles.find((vehicle) => vehicle.id === id),
      ...(options.data as object),
      id,
      status,
      dispatchNonce: id === "found" ? 2 : 1,
      store: {},
    }) as never);
    const queues = {
      freight: { add: vi.fn(), upsertJobScheduler: vi.fn() },
      hermes: { add: vi.fn().mockResolvedValue(undefined) },
    } as unknown as WorkerQueues;
    const processor = createFreightSweepProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher: {} as Redis,
      queues,
    });

    await processor(job);

    expect(loadDispatchWorkbook).toHaveBeenCalledOnce();
    expect(calculateFreight).toHaveBeenCalledTimes(2);
    expect(transitionVehicle).toHaveBeenNthCalledWith(
      1,
      prisma,
      "found",
      "READY",
      expect.objectContaining({
        eventType: "FREIGHT_SWEEP_FOUND",
        data: expect.objectContaining({
          freightAmount: 350,
          scheduledStartAt: new Date("2026-08-21T23:00:00.000Z"),
        }),
      }),
    );
    expect(transitionVehicle).toHaveBeenNthCalledWith(
      2,
      prisma,
      "waiting",
      "AWAITING_FREIGHT",
      expect.objectContaining({ eventType: "FREIGHT_SWEEP_MISS" }),
    );
    expect(queues.hermes.add).toHaveBeenCalledOnce();
    expect(queues.freight.add).not.toHaveBeenCalled();
  });
});
