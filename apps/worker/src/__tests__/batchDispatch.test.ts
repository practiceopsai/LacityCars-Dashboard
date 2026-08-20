import { describe, expect, it, vi, beforeEach } from "vitest";
import { DelayedError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@lacity/database";
import type { WorkerConfig } from "../config";
import { createBatchDispatchProcessor } from "../processors/batchDispatch";
import type { HermesJobData } from "../queues";

vi.mock("../hermesClient", () => ({ triggerHermes: vi.fn() }));
import { triggerHermes } from "../hermesClient";

const config = {
  PUBLIC_API_URL: "https://api.example.com/",
  HERMES_BUSY_DELAY_MS: 30_000,
} as WorkerConfig;

function vehicle(id: string, position: number, status = "READY") {
  return {
    id,
    vin: position === 1 ? "1HGCM82633A004352" : "1M8GDM9AXKP042788",
    model: `Vehicle ${position}`,
    stockNumber: null,
    status,
    batchPosition: position,
    hermesDispatchedAt: null,
    freightAmount: 100,
    freightEvidence: { loadId: "42" },
    corrections: [],
  };
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: "batch-1",
    groupKey: "group-1",
    name: "Load 42",
    transportReference: "42",
    status: "READY",
    dispatchNonce: 2,
    scheduledStartAt: new Date("2020-01-01T00:00:00.000Z"),
    store: {
      code: "LA_CITY",
      name: "LA City",
      autosoftInstance: "LA City Cars",
      stockPrefix: "L",
      internalCharges: [{ label: "Pack", amount: 55 }],
      chargesTotal: 55,
    },
    vehicles: [vehicle("veh-1", 1), vehicle("veh-2", 2)],
    ...overrides,
  };
}

function prismaMock(value: ReturnType<typeof batch>) {
  const prisma = {
    stockingBatch: {
      findUnique: vi.fn().mockResolvedValue(value),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue(value),
    },
    vehicle: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    vehicleEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  return prisma;
}

function job(): Job<HermesJobData> {
  return {
    id: "job-1",
    data: { batchId: "batch-1", nonce: 2 },
    opts: { attempts: 5 },
    attemptsMade: 0,
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<HermesJobData>;
}

beforeEach(() => vi.clearAllMocks());

describe("batch dispatch", () => {
  it("holds the entire batch until its not-before boundary", async () => {
    const start = new Date(Date.now() + 60_000);
    const prisma = prismaMock(batch({ scheduledStartAt: start }));
    const queued = job();
    const processor = createBatchDispatchProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher: {} as Redis,
    });
    await expect(processor(queued, "token")).rejects.toBeInstanceOf(DelayedError);
    expect(queued.moveToDelayed).toHaveBeenCalledWith(start.getTime(), "token");
    expect(triggerHermes).not.toHaveBeenCalled();
  });

  it("claims READY vehicles in order and sends one Hermes batch", async () => {
    const prisma = prismaMock(batch());
    const processor = createBatchDispatchProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher: {} as Redis,
    });
    await processor(job());
    expect(triggerHermes).toHaveBeenCalledOnce();
    expect(triggerHermes).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        request_id: "batch-1:2",
        vehicles: [
          expect.objectContaining({ vin: "1HGCM82633A004352" }),
          expect.objectContaining({ vin: "1M8GDM9AXKP042788" }),
        ],
      }),
    );
    expect(prisma.stockingBatch.updateMany).toHaveBeenCalledOnce();
    expect(prisma.vehicle.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.vehicleEvent.create).toHaveBeenCalledTimes(2);
  });

  it("excludes vehicles without defensible freight instead of guessing", async () => {
    const incomplete = vehicle("veh-2", 2, "AWAITING_FREIGHT");
    const prisma = prismaMock(batch({ vehicles: [vehicle("veh-1", 1), incomplete] }));
    const processor = createBatchDispatchProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher: {} as Redis,
    });
    await processor(job());
    const payload = vi.mocked(triggerHermes).mock.calls[0]![1];
    expect("vehicles" in payload ? payload.vehicles : []).toHaveLength(1);
  });
});
