import { beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@lacity/database";
import type { WorkerConfig } from "../config";
import { createHermesProcessor } from "../processors/hermesDispatch";
import type { HermesJobData, WorkerQueues } from "../queues";

vi.mock("../hermesClient", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, triggerHermes: vi.fn() };
});
vi.mock("../publish", () => ({ publishVehicle: vi.fn() }));
vi.mock("@lacity/database", () => ({ transitionVehicle: vi.fn() }));

import { triggerHermes } from "../hermesClient";
import { publishVehicle } from "../publish";
import { transitionVehicle } from "@lacity/database";

const config = {
  PUBLIC_API_URL: "https://api.example.com/",
  HERMES_ENDPOINT: "https://hermes.example.com/trigger",
  HERMES_BUSY_DELAY_MS: 30_000,
} as WorkerConfig;

const store = {
  code: "LAC",
  name: "LA City Cars",
  autosoftInstance: "lacity",
  stockPrefix: "LC",
  internalCharges: [{ label: "Detail", amount: 150 }],
  chargesTotal: 150,
};

function makeVehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: "veh-1",
    storeId: "store-la",
    stockingBatchId: null,
    vin: "1HGCM82633A004352",
    model: "Accord",
    stockNumber: "LC1001",
    status: "READY",
    dispatchNonce: 2,
    scheduledStartAt: new Date("2020-01-01T00:00:00.000Z"),
    freightAmount: 425.5,
    freightEvidence: { loadId: "L-9" },
    store,
    corrections: [],
    createdAt: new Date("2019-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makePrisma(vehicle: unknown, claimCount: number) {
  return {
    vehicle: {
      findUnique: vi.fn().mockResolvedValue(vehicle),
      findUniqueOrThrow: vi.fn().mockResolvedValue(vehicle),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: claimCount }),
    },
    vehicleEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    stockingBatch: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
}

function makeJob(): Job<HermesJobData> {
  return {
    data: { vehicleId: "veh-1", nonce: 2 },
    opts: { attempts: 5 },
    attemptsMade: 0,
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<HermesJobData>;
}

const publisher = {} as Redis;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(transitionVehicle).mockResolvedValue(
    makeVehicle({ status: "PROCESSING" }) as never,
  );
});

describe("createHermesProcessor", () => {
  it("drops jobs for unknown vehicles without claiming", async () => {
    const prisma = makePrisma(null, 0);
    const processor = createHermesProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher,
    });

    await processor(makeJob());

    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    expect(triggerHermes).not.toHaveBeenCalled();
  });

  it("skips dispatch when the idempotent claim matches zero rows", async () => {
    const prisma = makePrisma(makeVehicle({ status: "STOCKED" }), 0);
    const processor = createHermesProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher,
    });

    await processor(makeJob());

    expect(prisma.vehicle.updateMany).toHaveBeenCalledOnce();
    expect(triggerHermes).not.toHaveBeenCalled();
    expect(publishVehicle).not.toHaveBeenCalled();
  });

  it("delays a READY vehicle while another vehicle owns the desktop", async () => {
    const prisma = makePrisma(makeVehicle(), 1);
    prisma.vehicle.findFirst.mockResolvedValue({ id: "veh-active" });
    const job = makeJob();
    const processor = createHermesProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher,
    });

    await expect(processor(job, "worker-token")).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "worker-token");
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    expect(triggerHermes).not.toHaveBeenCalled();
  });

  it("does not claim or trigger a vehicle before its scheduled start", async () => {
    const scheduledStartAt = new Date(Date.now() + 60_000);
    const prisma = makePrisma(makeVehicle({ scheduledStartAt }), 1);
    const job = makeJob();
    const processor = createHermesProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher,
    });

    await expect(processor(job, "worker-token")).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(scheduledStartAt.getTime(), "worker-token");
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    expect(triggerHermes).not.toHaveBeenCalled();
  });

  it("drops a superseded scheduled job by dispatch nonce", async () => {
    const prisma = makePrisma(makeVehicle({ dispatchNonce: 3 }), 1);
    const processor = createHermesProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher,
    });

    await processor(makeJob());

    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    expect(triggerHermes).not.toHaveBeenCalled();
  });

  it("claims, triggers Hermes with callback URL and freight evidence, then publishes", async () => {
    const prisma = makePrisma(makeVehicle(), 1);
    const processor = createHermesProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher,
    });

    await processor(makeJob());

    expect(triggerHermes).toHaveBeenCalledOnce();
    expect(triggerHermes).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        request_id: "veh-1:2",
        callback_url: "https://api.example.com/api/webhooks/hermes",
        freight: { amount: 425.5, evidence: { loadId: "L-9" } },
        schedule: expect.objectContaining({ starts_at: "2020-01-01T00:00:00.000Z" }),
        store: expect.objectContaining({ code: "LAC" }),
      }),
    );

    expect(transitionVehicle).toHaveBeenCalledWith(
      prisma,
      "veh-1",
      "PROCESSING",
      expect.objectContaining({
        eventType: "HERMES_TRIGGERED",
      }),
    );
    expect(publishVehicle).toHaveBeenCalledOnce();
  });

  it("assembles all due freight-ready vehicles for one store before triggering Hermes", async () => {
    const vehicle = makeVehicle();
    const sibling = makeVehicle({ id: "veh-2", vin: "5YJ3E1EA7KF317000" });
    const tx = {
      stockingBatch: {
        create: vi.fn().mockResolvedValue({
          id: "batch-auto",
          dispatchNonce: 0,
          scheduledStartAt: new Date("2020-01-01T00:00:00.000Z"),
        }),
      },
      vehicle: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      vehicleEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      ...makePrisma(vehicle, 1),
      vehicle: {
        ...makePrisma(vehicle, 1).vehicle,
        findMany: vi.fn().mockResolvedValue([vehicle, sibling]),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const queues = {
      freight: { add: vi.fn() },
      hermes: { add: vi.fn().mockResolvedValue(undefined) },
      close: vi.fn(),
    } as unknown as WorkerQueues;
    const processor = createHermesProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher,
      queues,
    });

    await processor(makeJob());

    expect(tx.vehicle.updateMany).toHaveBeenCalledTimes(2);
    expect(queues.hermes.add).toHaveBeenCalledWith(
      "dispatch-batch",
      { batchId: "batch-auto", nonce: 0 },
      expect.objectContaining({ jobId: "hermes-batch-batch-auto-0" }),
    );
    expect(triggerHermes).not.toHaveBeenCalled();
  });

  it("releases the claim and rethrows when the Hermes trigger fails", async () => {
    const prisma = makePrisma(makeVehicle(), 1);
    vi.mocked(triggerHermes).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const processor = createHermesProcessor({
      prisma: prisma as unknown as PrismaClient,
      config,
      publisher,
    });

    await expect(processor(makeJob())).rejects.toThrow("ECONNREFUSED");

    // First updateMany claims; second releases the claim for the BullMQ retry.
    expect(prisma.vehicle.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.vehicle.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "veh-1", status: "READY", hermesRequestId: "veh-1:2" },
      data: { hermesDispatchedAt: null },
    });
    expect(prisma.vehicleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "HERMES_TRIGGER_FAILED" }),
      }),
    );
  });
});
