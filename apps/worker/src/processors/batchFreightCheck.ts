import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import { transitionVehicle, type PrismaClient } from "@lacity/database";
import { calculateFreight } from "@lacity/freight";
import type { WorkerConfig } from "../config";
import { nextFreightSweepHint } from "../freightSchedule";
import { logger } from "../logger";
import { publishVehicle } from "../publish";
import {
  enqueueBatchHermesDispatch,
  type FreightJobData,
  type WorkerQueues,
} from "../queues";
import { loadDispatchWorkbookForBatch, WorkbookSourceError } from "../workbookSource";

interface BatchFreightDeps {
  prisma: PrismaClient;
  config: WorkerConfig;
  publisher: Redis;
  queues: WorkerQueues;
}

/** Verify all unresolved VINs in a store batch against one workbook snapshot. */
export function createBatchFreightProcessor(deps: BatchFreightDeps) {
  const { prisma, config, publisher, queues } = deps;
  return async (job: Job<FreightJobData>): Promise<void> => {
    const { batchId } = job.data;
    if (!batchId) return;
    const batch = await prisma.stockingBatch.findUnique({
      where: { id: batchId },
      include: {
        vehicles: {
          where: { status: { in: ["PENDING", "AWAITING_FREIGHT"] } },
          include: { store: true },
          orderBy: [{ batchPosition: "asc" }, { createdAt: "asc" }],
        },
      },
    });
    if (!batch || ["COMPLETED", "FAILED"].includes(batch.status) || batch.vehicles.length === 0) return;

    let snapshot;
    try {
      snapshot = await loadDispatchWorkbookForBatch(config);
    } catch (error) {
      const message = error instanceof WorkbookSourceError ? error.message : String(error);
      await prisma.vehicleEvent.createMany({
        data: batch.vehicles.map((vehicle) => ({
          vehicleId: vehicle.id,
          type: "BATCH_FREIGHT_CHECK_ERROR",
          message: `Workbook unavailable: ${message}`,
        })),
      });
      await prisma.vehicle.updateMany({
        where: { id: { in: batch.vehicles.map((vehicle) => vehicle.id) } },
        data: { nextFreightCheckAt: nextFreightSweepHint() },
      });
      return;
    }

    let foundCount = 0;
    for (const vehicle of batch.vehicles) {
      const result = calculateFreight(snapshot.rows, vehicle.vin);
      if (result.found) {
        const updated = await transitionVehicle(prisma, vehicle.id, "READY", {
          eventType: "BATCH_FREIGHT_FOUND",
          message: `Freight $${result.amount.toFixed(2)} = load $${result.evidence.loadPrice} / ${result.evidence.distinctVinCount} VINs (load ${result.evidence.loadId})`,
          payload: { evidence: { ...result.evidence }, source: snapshot.source, fetchedAt: snapshot.fetchedAt },
          data: {
            freightAmount: result.amount,
            freightEvidence: { ...result.evidence, source: snapshot.source, fetchedAt: snapshot.fetchedAt },
            nextFreightCheckAt: null,
            failureReason: null,
          },
        });
        await publishVehicle(publisher, updated);
        foundCount += 1;
        continue;
      }

      const attempts = vehicle.freightAttempts + 1;
      const updated = await transitionVehicle(prisma, vehicle.id, "AWAITING_FREIGHT", {
        eventType: "BATCH_FREIGHT_MISS",
        message: `${result.reason}: ${result.detail}. Remaining in the twice-daily freight queue; freight was not estimated.`,
        payload: { reason: result.reason, detail: result.detail, attempt: attempts, batchId },
        data: {
          freightAttempts: attempts,
          nextFreightCheckAt: nextFreightSweepHint(),
          failureReason: null,
        },
      });
      await publishVehicle(publisher, updated);
    }

    if (foundCount > 0 && batch.status !== "PROCESSING") {
      const queued = await prisma.stockingBatch.update({
        where: { id: batch.id },
        data: { status: "READY", dispatchNonce: { increment: 1 } },
      });
      await enqueueBatchHermesDispatch(queues, queued.id, queued.dispatchNonce, queued.scheduledStartAt);
    }
    logger.info({ batchId, checked: batch.vehicles.length, found: foundCount }, "Batch freight snapshot applied");
  };
}
