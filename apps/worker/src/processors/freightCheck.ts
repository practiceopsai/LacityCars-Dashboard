import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import { transitionVehicle, type PrismaClient } from "@lacity/database";
import { calculateFreight } from "@lacity/freight";
import { freightBackoffMs, type VehicleStatus } from "@lacity/shared";
import type { WorkerConfig } from "../config";
import { logger } from "../logger";
import { publishVehicle } from "../publish";
import { enqueueFreightCheck, enqueueHermesDispatch, type FreightJobData, type WorkerQueues } from "../queues";
import { loadDispatchWorkbook, WorkbookSourceError } from "../workbookSource";

const CHECKABLE_STATUSES: VehicleStatus[] = ["PENDING", "AWAITING_FREIGHT"];
const SOURCE_ERROR_RETRY_MS = 5 * 60 * 1000;

export interface FreightDeps {
  prisma: PrismaClient;
  config: WorkerConfig;
  publisher: Redis;
  queues: WorkerQueues;
}

/**
 * Verify freight for one vehicle against a fresh dispatch workbook.
 * Found -> READY (+ queue Hermes dispatch). Miss -> AWAITING_FREIGHT with
 * exponential backoff, ACTION_REQUIRED once attempts are exhausted.
 * Freight is never estimated; a miss is always a miss.
 */
export function createFreightProcessor(deps: FreightDeps) {
  const { prisma, config, publisher, queues } = deps;

  return async (job: Job<FreightJobData>): Promise<void> => {
    const { vehicleId, nonce } = job.data;
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { store: true },
    });
    if (!vehicle) {
      logger.warn({ vehicleId }, "Freight check for unknown vehicle; dropping");
      return;
    }
    if (nonce !== vehicle.dispatchNonce) {
      logger.info({ vehicleId, jobNonce: nonce, currentNonce: vehicle.dispatchNonce }, "Stale freight job dropped");
      return;
    }
    if (!CHECKABLE_STATUSES.includes(vehicle.status as VehicleStatus)) {
      logger.info({ vehicleId, status: vehicle.status }, "Vehicle not awaiting freight; skipping check");
      return;
    }

    let snapshot;
    try {
      snapshot = await loadDispatchWorkbook(config);
    } catch (err) {
      // Infrastructure/parse problems are not freight misses: they do not
      // consume attempts, they just reschedule and leave a timeline event.
      const message = err instanceof WorkbookSourceError ? err.message : String(err);
      logger.error({ vehicleId, err }, "Dispatch workbook unavailable");
      await prisma.vehicleEvent.create({
        data: {
          vehicleId,
          type: "FREIGHT_CHECK_ERROR",
          message: `Workbook unavailable: ${message}`,
        },
      });
      await prisma.vehicle.update({
        where: { id: vehicleId },
        data: { nextFreightCheckAt: new Date(Date.now() + SOURCE_ERROR_RETRY_MS) },
      });
      await enqueueFreightCheck(queues, vehicleId, {
        nonce: vehicle.dispatchNonce,
        attempt: vehicle.freightAttempts,
        delayMs: SOURCE_ERROR_RETRY_MS,
      });
      return;
    }

    const result = calculateFreight(snapshot.rows, vehicle.vin);

    if (result.found) {
      const updated = await transitionVehicle(prisma, vehicleId, "READY", {
        eventType: "FREIGHT_FOUND",
        message: `Freight $${result.amount.toFixed(2)} = load $${result.evidence.loadPrice} / ${result.evidence.distinctVinCount} VINs (load ${result.evidence.loadId})`,
        payload: {
          evidence: { ...result.evidence },
          source: snapshot.source,
          fetchedAt: snapshot.fetchedAt,
        },
        data: {
          freightAmount: result.amount,
          freightEvidence: {
            ...result.evidence,
            source: snapshot.source,
            fetchedAt: snapshot.fetchedAt,
          },
          nextFreightCheckAt: null,
          failureReason: null,
        },
      });
      await enqueueHermesDispatch(
        queues,
        vehicleId,
        updated.dispatchNonce,
        updated.scheduledStartAt,
      );
      await publishVehicle(publisher, updated);
      logger.info({ vehicleId, amount: result.amount }, "Freight verified; Hermes dispatch queued");
      return;
    }

    const attempts = vehicle.freightAttempts + 1;
    if (attempts >= config.FREIGHT_MAX_ATTEMPTS) {
      const updated = await transitionVehicle(prisma, vehicleId, "ACTION_REQUIRED", {
        eventType: "FREIGHT_EXHAUSTED",
        message: `Freight not found after ${attempts} checks (${result.reason}). Operator input required.`,
        payload: { reason: result.reason, detail: result.detail, attempts },
        data: {
          freightAttempts: attempts,
          nextFreightCheckAt: null,
          failureReason: `Freight not found after ${attempts} checks: ${result.detail}`,
        },
      });
      await publishVehicle(publisher, updated);
      logger.warn({ vehicleId, attempts }, "Freight attempts exhausted");
      return;
    }

    const delayMs = freightBackoffMs(
      attempts,
      config.FREIGHT_BACKOFF_BASE_MS,
      config.FREIGHT_BACKOFF_MAX_MS,
    );
    const updated = await transitionVehicle(prisma, vehicleId, "AWAITING_FREIGHT", {
      eventType: "FREIGHT_MISS",
      message: `${result.reason}: ${result.detail}. Next check in ${Math.round(delayMs / 60000)} min.`,
      payload: { reason: result.reason, detail: result.detail, attempt: attempts },
      data: {
        freightAttempts: attempts,
        nextFreightCheckAt: new Date(Date.now() + delayMs),
      },
    });
    await enqueueFreightCheck(queues, vehicleId, {
      nonce: vehicle.dispatchNonce,
      attempt: attempts,
      delayMs,
    });
    await publishVehicle(publisher, updated);
    logger.info({ vehicleId, attempts, delayMs, reason: result.reason }, "Freight miss; retry scheduled");
  };
}
