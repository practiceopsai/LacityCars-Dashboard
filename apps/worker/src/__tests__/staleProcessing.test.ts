import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { PrismaClient, VehicleWithStore } from "@lacity/database";
import {
  recoverStaleBatches,
  recoverStaleProcessing,
  resumeUnclaimedReadyBatches,
} from "../staleProcessing";
import type { WorkerQueues } from "../queues";

vi.mock("../queues", async (importOriginal) => {
  const original = await importOriginal<typeof import("../queues")>();
  return { ...original, enqueueBatchHermesDispatch: vi.fn() };
});
import { enqueueBatchHermesDispatch } from "../queues";

beforeEach(() => vi.clearAllMocks());

const publisher = {} as Redis;

function makePrisma(rows: unknown[]) {
  return {
    vehicle: { findMany: vi.fn().mockResolvedValue(rows) },
  } as unknown as PrismaClient;
}

describe("recoverStaleProcessing", () => {
  it("marks stale work failed and publishes the update", async () => {
    const prisma = makePrisma([
      { id: "veh-1", vin: "1HGCM82633A004352", hermesRequestId: "veh-1:0" },
    ]);
    const updated = { id: "veh-1", status: "FAILED" } as VehicleWithStore;
    const transition = vi.fn().mockResolvedValue(updated);
    const publish = vi.fn().mockResolvedValue(undefined);

    const count = await recoverStaleProcessing({
      prisma,
      publisher,
      timeoutMs: 90 * 60 * 1000,
      now: new Date("2026-08-20T02:00:00.000Z"),
      transition,
      publish,
    });

    expect(count).toBe(1);
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith({
      where: {
        status: "PROCESSING",
        hermesDispatchedAt: { lte: new Date("2026-08-20T00:30:00.000Z") },
      },
      select: { id: true, vin: true, hermesRequestId: true },
    });
    expect(transition).toHaveBeenCalledWith(
      prisma,
      "veh-1",
      "FAILED",
      expect.objectContaining({ eventType: "HERMES_CALLBACK_TIMEOUT" }),
    );
    expect(publish).toHaveBeenCalledWith(publisher, updated);
  });

  it("does nothing when no processing job is stale", async () => {
    const prisma = makePrisma([]);
    const transition = vi.fn();
    const publish = vi.fn();

    const count = await recoverStaleProcessing({
      prisma,
      publisher,
      timeoutMs: 90 * 60 * 1000,
      transition,
      publish,
    });

    expect(count).toBe(0);
    expect(transition).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("recoverStaleBatches", () => {
  it("fails every claimed non-terminal child and releases the desktop lock", async () => {
    const child = {
      id: "veh-1",
      status: "READY",
      store: { id: "store-1" },
    };
    const prisma = {
      stockingBatch: {
        findMany: vi.fn().mockResolvedValue([
          { id: "batch-1", name: "Load 42", hermesRequestId: "batch-1:1", vehicles: [child] },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const updated = { ...child, status: "FAILED" } as unknown as VehicleWithStore;
    const transition = vi.fn().mockResolvedValue(updated);
    const publish = vi.fn().mockResolvedValue(undefined);

    const count = await recoverStaleBatches({
      prisma,
      publisher,
      timeoutMs: 90 * 60 * 1000,
      now: new Date("2026-08-20T02:00:00.000Z"),
      transition,
      publish,
    });

    expect(count).toBe(1);
    expect(transition).toHaveBeenCalledWith(
      prisma,
      "veh-1",
      "FAILED",
      expect.objectContaining({ eventType: "BATCH_CALLBACK_TIMEOUT" }),
    );
    expect(prisma.stockingBatch.updateMany).toHaveBeenCalledWith({
      where: { id: "batch-1", status: "PROCESSING" },
      data: { status: "FAILED", hermesDispatchedAt: null },
    });
  });
});

describe("resumeUnclaimedReadyBatches", () => {
  it("queues only never-claimed READY children under a new nonce", async () => {
    const safe = {
      id: "veh-ready",
      status: "READY",
      hermesDispatchedAt: null,
      freightAmount: 500,
      freightEvidence: { loadId: "42" },
    };
    const prisma = {
      stockingBatch: {
        findMany: vi.fn().mockResolvedValue([
          { id: "batch-1", vehicles: [safe] },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "batch-1",
          dispatchNonce: 7,
          scheduledStartAt: new Date("2026-08-22T08:25:00.000Z"),
        }),
      },
      vehicleEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as PrismaClient;

    const resumed = await resumeUnclaimedReadyBatches({
      prisma,
      publisher,
      queues: {} as WorkerQueues,
      timeoutMs: 60_000,
    });

    expect(resumed).toBe(1);
    expect(prisma.stockingBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "batch-1", status: { in: ["FAILED", "PARTIAL"] } },
        data: expect.objectContaining({ status: "READY", dispatchNonce: { increment: 1 } }),
      }),
    );
    expect(enqueueBatchHermesDispatch).toHaveBeenCalledWith(
      expect.anything(),
      "batch-1",
      7,
      new Date("2026-08-22T08:25:00.000Z"),
    );
  });

  it("does not resume a batch with any claimed or processing child", async () => {
    const prisma = {
      stockingBatch: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "batch-1",
            vehicles: [
              {
                id: "veh-claimed",
                status: "READY",
                hermesDispatchedAt: new Date(),
                freightAmount: 500,
                freightEvidence: { loadId: "42" },
              },
              {
                id: "veh-safe",
                status: "READY",
                hermesDispatchedAt: null,
                freightAmount: 500,
                freightEvidence: { loadId: "42" },
              },
            ],
          },
        ]),
        updateMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    const resumed = await resumeUnclaimedReadyBatches({
      prisma,
      publisher,
      queues: {} as WorkerQueues,
      timeoutMs: 60_000,
    });

    expect(resumed).toBe(0);
    expect(prisma.stockingBatch.updateMany).not.toHaveBeenCalled();
    expect(enqueueBatchHermesDispatch).not.toHaveBeenCalled();
  });
});
