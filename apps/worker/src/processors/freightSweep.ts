import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import { transitionVehicle, type PrismaClient } from "@lacity/database";
import { calculateFreight } from "@lacity/freight";
import type { WorkerConfig } from "../config";
import { nextFreightSweepHint, nextStockingWindow } from "../freightSchedule";
import { logger } from "../logger";
import { publishVehicle } from "../publish";
import {
  enqueueBatchHermesDispatch,
  enqueueHermesDispatch,
  type FreightJobData,
  type WorkerQueues,
} from "../queues";
import { loadDispatchWorkbook, WorkbookSourceError } from "../workbookSource";

interface FreightSweepDeps {
  prisma: PrismaClient;
  config: WorkerConfig;
  publisher: Redis;
  queues: WorkerQueues;
}

/**
 * Check every unresolved VIN against one fresh dispatch snapshot. Unmatched
 * VINs stay parked indefinitely; matched VINs retain (or roll forward) their
 * shared-account stocking window and enter READY with defensible evidence.
 */
export function createFreightSweepProcessor(deps: FreightSweepDeps) {
  const { prisma, config, publisher, queues } = deps;

  return async (_job: Job<FreightJobData>): Promise<void> => {
    const vehicles = await prisma.vehicle.findMany({
      where: { status: { in: ["PENDING", "AWAITING_FREIGHT"] } },
      include: { store: true, stockingBatch: true },
      orderBy: [{ storeId: "asc" }, { createdAt: "asc" }],
    });
    if (vehicles.length === 0) {
      logger.info("Twice-daily freight sweep found no waiting vehicles");
      return;
    }

    let snapshot;
    try {
      snapshot = await loadDispatchWorkbook(config);
    } catch (error) {
      const message = error instanceof WorkbookSourceError ? error.message : String(error);
      const nextCheckAt = nextFreightSweepHint();
      await prisma.$transaction([
        prisma.vehicleEvent.createMany({
          data: vehicles.map((vehicle) => ({
            vehicleId: vehicle.id,
            type: "FREIGHT_SWEEP_ERROR",
            message: `Twice-daily dispatch workbook unavailable: ${message}`,
          })),
        }),
        prisma.vehicle.updateMany({
          where: { id: { in: vehicles.map((vehicle) => vehicle.id) } },
          data: { nextFreightCheckAt: nextCheckAt },
        }),
      ]);
      logger.error({ err: error, waiting: vehicles.length }, "Twice-daily freight sweep could not load workbook");
      return;
    }

    const batchesToQueue = new Map<string, Date>();
    let found = 0;
    let waiting = 0;

    for (const vehicle of vehicles) {
      const result = calculateFreight(snapshot.rows, vehicle.vin);
      if (!result.found) {
        const attempts = vehicle.freightAttempts + 1;
        const nextCheckAt = nextFreightSweepHint();
        const updated = await transitionVehicle(prisma, vehicle.id, "AWAITING_FREIGHT", {
          eventType: "FREIGHT_SWEEP_MISS",
          message: `${result.reason}: ${result.detail}. Remaining in the twice-daily freight queue; freight was not estimated.`,
          payload: { reason: result.reason, detail: result.detail, attempt: attempts },
          data: {
            freightAttempts: attempts,
            nextFreightCheckAt: nextCheckAt,
            failureReason: null,
          },
        });
        await publishVehicle(publisher, updated);
        waiting += 1;
        continue;
      }

      const scheduleSource = vehicle.stockingBatch?.scheduledStartAt ?? vehicle.scheduledStartAt;
      const scheduledStartAt = nextStockingWindow(scheduleSource);
      const scheduleRolled =
        scheduledStartAt !== null &&
        scheduleSource !== null &&
        scheduledStartAt.getTime() !== scheduleSource.getTime();
      const updated = await transitionVehicle(prisma, vehicle.id, "READY", {
        eventType: "FREIGHT_SWEEP_FOUND",
        message: `Freight $${result.amount.toFixed(2)} = load $${result.evidence.loadPrice} / ${result.evidence.distinctVinCount} VINs (load ${result.evidence.loadId}).${scheduleRolled ? ` Missed stocking window advanced to ${scheduledStartAt!.toISOString()}.` : ""}`,
        payload: {
          evidence: { ...result.evidence },
          source: snapshot.source,
          fetchedAt: snapshot.fetchedAt,
          scheduleRolled,
          scheduledStartAt: scheduledStartAt?.toISOString() ?? null,
        },
        data: {
          freightAmount: result.amount,
          freightEvidence: {
            ...result.evidence,
            source: snapshot.source,
            fetchedAt: snapshot.fetchedAt,
          },
          scheduledStartAt,
          nextFreightCheckAt: null,
          failureReason: null,
        },
      });
      await publishVehicle(publisher, updated);
      found += 1;

      if (vehicle.stockingBatchId && scheduledStartAt) {
        batchesToQueue.set(vehicle.stockingBatchId, scheduledStartAt);
      } else {
        await enqueueHermesDispatch(queues, vehicle.id, updated.dispatchNonce, scheduledStartAt);
      }
    }

    for (const [batchId, scheduledStartAt] of batchesToQueue) {
      const existing = await prisma.stockingBatch.findUnique({ where: { id: batchId } });
      if (!existing || ["PROCESSING", "COMPLETED", "FAILED"].includes(existing.status)) continue;
      const batch = await prisma.stockingBatch.update({
        where: { id: batchId },
        data: {
          status: "READY",
          scheduledStartAt,
          dispatchNonce: { increment: 1 },
          hermesDispatchedAt: null,
          hermesRequestId: null,
        },
      });
      await enqueueBatchHermesDispatch(queues, batch.id, batch.dispatchNonce, batch.scheduledStartAt);
    }

    logger.info(
      { checked: vehicles.length, found, waiting, source: snapshot.source },
      "Twice-daily freight sweep complete",
    );
  };
}
