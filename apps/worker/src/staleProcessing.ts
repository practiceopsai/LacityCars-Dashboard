import { transitionVehicle, type PrismaClient, type VehicleWithStore } from "@lacity/database";
import type { Redis } from "ioredis";
import { logger } from "./logger";
import { publishVehicle } from "./publish";
import { enqueueBatchHermesDispatch, type WorkerQueues } from "./queues";

type Transition = typeof transitionVehicle;
type Publish = (publisher: Redis, vehicle: VehicleWithStore) => Promise<void>;

export interface StaleProcessingDeps {
  prisma: PrismaClient;
  publisher: Redis;
  timeoutMs: number;
  now?: Date;
  transition?: Transition;
  publish?: Publish;
}

export interface BatchContinuationDeps extends StaleProcessingDeps {
  queues: WorkerQueues;
}

/**
 * Fail closed when Hermes accepted a job but never supplied a terminal
 * callback. Without this guard one abandoned PROCESSING row blocks the single
 * AutoSoft desktop queue forever. Operators can verify external state and use
 * the normal audited retry action afterward.
 */
export async function recoverStaleProcessing(deps: StaleProcessingDeps): Promise<number> {
  const transition = deps.transition ?? transitionVehicle;
  const publish = deps.publish ?? publishVehicle;
  const cutoff = new Date((deps.now ?? new Date()).getTime() - deps.timeoutMs);
  const stale = await deps.prisma.vehicle.findMany({
    where: {
      status: "PROCESSING",
      hermesDispatchedAt: { lte: cutoff },
    },
    select: { id: true, vin: true, hermesRequestId: true },
  });

  let recovered = 0;
  for (const vehicle of stale) {
    try {
      const updated = await transition(deps.prisma, vehicle.id, "FAILED", {
        eventType: "HERMES_CALLBACK_TIMEOUT",
        message: "Hermes did not send a terminal callback before the processing timeout",
        data: {
          failureReason: "Hermes terminal callback timeout; verify live systems before retrying",
        },
        payload: {
          request_id: vehicle.hermesRequestId,
          cutoff: cutoff.toISOString(),
        },
      });
      await publish(deps.publisher, updated);
      recovered += 1;
      logger.warn(
        { vehicleId: vehicle.id, vin: vehicle.vin, requestId: vehicle.hermesRequestId },
        "Recovered stale Hermes processing job",
      );
    } catch (err) {
      // A callback may have won the race after findMany. Never overwrite it.
      logger.warn({ err, vehicleId: vehicle.id }, "Stale Hermes recovery skipped after state changed");
    }
  }
  return recovered;
}

/**
 * Fail every non-terminal child closed when a single-session batch stops
 * producing callbacks. READY children with a dispatch claim may already have
 * been touched in AutoSoft, so they require audited operator review too.
 */
export async function recoverStaleBatches(deps: StaleProcessingDeps): Promise<number> {
  const transition = deps.transition ?? transitionVehicle;
  const publish = deps.publish ?? publishVehicle;
  const cutoff = new Date((deps.now ?? new Date()).getTime() - deps.timeoutMs);
  const stale = await deps.prisma.stockingBatch.findMany({
    where: { status: "PROCESSING", startedAt: { lte: cutoff } },
    include: {
      vehicles: {
        where: { status: { in: ["READY", "PROCESSING"] }, hermesDispatchedAt: { not: null } },
        include: { store: true },
      },
    },
  });

  let recovered = 0;
  for (const batch of stale) {
    for (const vehicle of batch.vehicles) {
      try {
        const updated = await transition(deps.prisma, vehicle.id, "FAILED", {
          eventType: "BATCH_CALLBACK_TIMEOUT",
          message: `Batch ${batch.name} stopped sending callbacks before the timeout`,
          data: { failureReason: "Batch callback timeout; verify sheet and AutoSoft before retrying" },
          payload: { batchId: batch.id, batchRequestId: batch.hermesRequestId, cutoff: cutoff.toISOString() },
        });
        await publish(deps.publisher, updated);
      } catch (error) {
        logger.warn({ error, batchId: batch.id, vehicleId: vehicle.id }, "Stale batch child changed concurrently");
      }
    }
    const changed = await deps.prisma.stockingBatch.updateMany({
      where: { id: batch.id, status: "PROCESSING" },
      data: { status: "FAILED", hermesDispatchedAt: null },
    });
    recovered += changed.count;
  }
  return recovered;
}

/**
 * Resume only children that were never claimed by the failed execution
 * window. A READY child with hermesDispatchedAt=null was absent from the
 * prior Hermes payload, so it is safe to keep its sheet row and dispatch it
 * under a new nonce. Claimed/PROCESSING children remain fail-closed for
 * operator review and can never be swept into this continuation.
 *
 * Including terminal FAILED/PARTIAL batches repairs batches stranded by the
 * older timeout watchdog after a worker restart without resetting failed or
 * completed vehicles.
 */
export async function resumeUnclaimedReadyBatches(deps: BatchContinuationDeps): Promise<number> {
  const candidates = await deps.prisma.stockingBatch.findMany({
    where: {
      status: { in: ["FAILED", "PARTIAL"] },
      AND: [
        {
          vehicles: {
            some: {
              status: "READY",
              hermesDispatchedAt: null,
              freightAmount: { not: null },
            },
          },
        },
        { vehicles: { some: { status: { in: ["COMPLETED", "FAILED"] } } } },
      ],
    },
    include: {
      vehicles: {
        select: {
          id: true,
          status: true,
          hermesDispatchedAt: true,
          freightAmount: true,
          freightEvidence: true,
        },
      },
    },
  });

  let resumed = 0;
  for (const batch of candidates) {
    const hasTerminalChild = batch.vehicles.some(
      (vehicle) => vehicle.status === "COMPLETED" || vehicle.status === "FAILED",
    );
    const uncertain = batch.vehicles.some(
      (vehicle) =>
        vehicle.status === "PROCESSING" ||
        (vehicle.status === "READY" && vehicle.hermesDispatchedAt !== null),
    );
    const safeReady = batch.vehicles.filter(
      (vehicle) =>
        vehicle.status === "READY" &&
        vehicle.hermesDispatchedAt === null &&
        vehicle.freightAmount !== null &&
        vehicle.freightEvidence !== null,
    );
    if (!hasTerminalChild || uncertain || safeReady.length === 0) continue;

    const changed = await deps.prisma.stockingBatch.updateMany({
      where: { id: batch.id, status: { in: ["FAILED", "PARTIAL"] } },
      data: {
        status: "READY",
        dispatchNonce: { increment: 1 },
        hermesDispatchedAt: null,
        hermesRequestId: null,
        startedAt: null,
        completedAt: null,
      },
    });
    if (changed.count !== 1) continue;
    const continuation = await deps.prisma.stockingBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { id: true, dispatchNonce: true, scheduledStartAt: true },
    });
    await deps.prisma.vehicleEvent.createMany({
      data: safeReady.map((vehicle) => ({
        vehicleId: vehicle.id,
        type: "BATCH_CONTINUATION_QUEUED",
        fromStatus: "READY",
        toStatus: "READY",
        message: "Queued after the prior execution window ended; this vehicle was never claimed",
        payload: { batchId: batch.id, dispatchNonce: continuation.dispatchNonce },
      })),
    });
    await enqueueBatchHermesDispatch(
      deps.queues,
      continuation.id,
      continuation.dispatchNonce,
      continuation.scheduledStartAt,
    );
    resumed += 1;
    logger.info(
      { batchId: batch.id, vehicleCount: safeReady.length, dispatchNonce: continuation.dispatchNonce },
      "Queued safe unclaimed batch continuation",
    );
  }
  return resumed;
}
