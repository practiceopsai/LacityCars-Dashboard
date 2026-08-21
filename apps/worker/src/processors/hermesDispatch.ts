import { randomUUID } from "node:crypto";
import { DelayedError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { transitionVehicle, type PrismaClient } from "@lacity/database";
import {
  stockingScheduleLabels,
  type HermesTriggerPayload,
  type InternalCharge,
} from "@lacity/shared";
import type { WorkerConfig } from "../config";
import { HermesTriggerError, triggerHermes } from "../hermesClient";
import { logger } from "../logger";
import { publishVehicle } from "../publish";
import {
  enqueueBatchHermesDispatch,
  type HermesJobData,
  type WorkerQueues,
} from "../queues";

export interface HermesDeps {
  prisma: PrismaClient;
  config: WorkerConfig;
  publisher: Redis;
  queues?: WorkerQueues;
}

/**
 * Convert due, freight-verified standalone work into one store-locked batch.
 * The Hermes worker has concurrency=1, so this transaction is the single
 * assembly point and queued single-vehicle jobs become harmless no-ops once
 * their records carry a batch ID.
 */
async function assembleDueStoreBatch(
  prisma: PrismaClient,
  queues: WorkerQueues,
  storeId: string,
  storeName: string,
): Promise<string | null> {
  const now = new Date();
  const due = await prisma.vehicle.findMany({
    where: {
      storeId,
      stockingBatchId: null,
      status: "READY",
      hermesDispatchedAt: null,
      scheduledStartAt: { lte: now },
    },
    orderBy: [{ scheduledStartAt: "asc" }, { createdAt: "asc" }],
  });
  const ready = due.filter(
    (candidate) => candidate.freightAmount !== null && candidate.freightEvidence !== null,
  );
  if (ready.length === 0) return null;

  const groupKey = randomUUID();
  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.stockingBatch.create({
      data: {
        groupKey,
        name: `${storeName} automatic freight-ready batch`,
        storeId,
        status: "READY",
        scheduledStartAt: now,
      },
    });
    for (let index = 0; index < ready.length; index += 1) {
      const candidate = ready[index]!;
      const claimed = await tx.vehicle.updateMany({
        where: {
          id: candidate.id,
          stockingBatchId: null,
          status: "READY",
          hermesDispatchedAt: null,
        },
        data: { stockingBatchId: created.id, batchPosition: index + 1 },
      });
      if (claimed.count !== 1) throw new Error(`Could not batch READY vehicle ${candidate.id}`);
      await tx.vehicleEvent.create({
        data: {
          vehicleId: candidate.id,
          type: "AUTOMATIC_BATCH_ASSIGNED",
          fromStatus: "READY",
          toStatus: "READY",
          message: `Grouped into ${storeName} freight-ready batch`,
          payload: { batchId: created.id, groupKey, position: index + 1 },
        },
      });
    }
    return created;
  });
  await enqueueBatchHermesDispatch(queues, batch.id, batch.dispatchNonce, batch.scheduledStartAt);
  return batch.id;
}

/**
 * Trigger the Hermes agent for a READY vehicle.
 *
 * Idempotency/concurrency: a conditional update claims the vehicle
 * (status=READY AND hermesDispatchedAt IS NULL) before any network call.
 * Zero rows updated means another worker already claimed it, it was already
 * dispatched, or state moved on — in every case we do nothing. On send
 * failure the claim is released (only if the vehicle is still READY) so the
 * BullMQ retry can claim it again.
 */
export function createHermesProcessor(deps: HermesDeps) {
  const { prisma, config, publisher, queues } = deps;

  return async (job: Job<HermesJobData>, token?: string): Promise<void> => {
    const { vehicleId, nonce } = job.data;
    if (!vehicleId) {
      logger.warn({ jobId: job.id }, "Vehicle Hermes job missing vehicleId; dropping");
      return;
    }
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { store: true, corrections: { orderBy: { createdAt: "asc" } } },
    });
    if (!vehicle) {
      logger.warn({ vehicleId }, "Hermes dispatch for unknown vehicle; dropping");
      return;
    }
    if (nonce !== vehicle.dispatchNonce) {
      logger.info({ vehicleId, jobNonce: nonce, currentNonce: vehicle.dispatchNonce }, "Stale Hermes job dropped");
      return;
    }
    if (vehicle.stockingBatchId) {
      logger.info({ vehicleId, batchId: vehicle.stockingBatchId }, "Standalone job replaced by store batch");
      return;
    }

    if (!vehicle.scheduledStartAt) {
      const updated = await transitionVehicle(prisma, vehicleId, "ACTION_REQUIRED", {
        eventType: "SCHEDULE_MISSING",
        message: "Hermes dispatch blocked because no stocking schedule was assigned",
        data: { failureReason: "Missing scheduled stocking time" },
      });
      await publishVehicle(publisher, updated);
      return;
    }
    if (vehicle.scheduledStartAt.getTime() > Date.now()) {
      await job.moveToDelayed(vehicle.scheduledStartAt.getTime(), token);
      logger.info(
        { vehicleId, scheduledStartAt: vehicle.scheduledStartAt.toISOString() },
        "Hermes dispatch held until scheduled time",
      );
      throw new DelayedError();
    }

    // Hermes webhook deliveries use independent sessions, so the gateway can
    // run them concurrently. AutoSoft cannot. Keep later READY vehicles in the
    // BullMQ delayed set until the currently PROCESSING vehicle completes.
    const activeVehicle = await prisma.vehicle.findFirst({
      where: { status: "PROCESSING", id: { not: vehicleId } },
      select: { id: true },
    });
    const activeBatch = await prisma.stockingBatch.findFirst({
      where: { status: "PROCESSING" },
      select: { id: true },
    });
    if (activeVehicle || activeBatch) {
      await job.moveToDelayed(Date.now() + config.HERMES_BUSY_DELAY_MS, token);
      logger.info(
        { vehicleId, activeVehicleId: activeVehicle?.id, activeBatchId: activeBatch?.id },
        "Hermes desktop busy; dispatch delayed",
      );
      throw new DelayedError();
    }

    if (queues) {
      const batchId = await assembleDueStoreBatch(
        prisma,
        queues,
        vehicle.storeId,
        vehicle.store.name,
      );
      if (batchId) {
        logger.info({ vehicleId, batchId, storeId: vehicle.storeId }, "Due store vehicles assembled into batch");
        return;
      }
    }

    const requestId = `${vehicle.id}:${vehicle.dispatchNonce}`;
    const claimed = await prisma.vehicle.updateMany({
      where: { id: vehicleId, status: "READY", hermesDispatchedAt: null },
      data: { hermesDispatchedAt: new Date(), hermesRequestId: requestId },
    });
    if (claimed.count === 0) {
      logger.info(
        { vehicleId, status: vehicle.status },
        "Hermes dispatch skipped (already claimed, dispatched, or state moved on)",
      );
      return;
    }

    if (vehicle.freightAmount === null || vehicle.freightEvidence === null) {
      // Defensive: READY requires defensible freight. Surface instead of guessing.
      const updated = await transitionVehicle(prisma, vehicleId, "ACTION_REQUIRED", {
        eventType: "DISPATCH_BLOCKED",
        message: "Vehicle reached READY without freight evidence; refusing to trigger Hermes",
        data: { failureReason: "READY without freight evidence", hermesDispatchedAt: null },
      });
      await publishVehicle(publisher, updated);
      return;
    }

    const payload: HermesTriggerPayload = {
      request_id: requestId,
      callback_url: `${config.PUBLIC_API_URL.replace(/\/$/, "")}/api/webhooks/hermes`,
      schedule: {
        starts_at: vehicle.scheduledStartAt.toISOString(),
        ...stockingScheduleLabels(vehicle.scheduledStartAt),
      },
      store: {
        code: vehicle.store.code,
        name: vehicle.store.name,
        autosoft_instance: vehicle.store.autosoftInstance,
        stock_prefix: vehicle.store.stockPrefix,
        internal_charges: vehicle.store.internalCharges as unknown as InternalCharge[],
        charges_total: vehicle.store.chargesTotal,
      },
      vehicle: {
        vin: vehicle.vin,
        model: vehicle.model,
        stock_number: vehicle.stockNumber,
      },
      freight: {
        amount: Number(vehicle.freightAmount),
        evidence: vehicle.freightEvidence as Record<string, unknown>,
      },
      corrections: vehicle.corrections.map((c) => ({
        note: c.note,
        fields: (c.fields as Record<string, string> | null) ?? null,
        created_at: c.createdAt.toISOString(),
      })),
    };

    try {
      await triggerHermes(config, payload);
    } catch (err) {
      // Release the claim so a retry can re-dispatch — but never clobber a
      // vehicle a fast callback has already moved past READY.
      await prisma.vehicle.updateMany({
        where: { id: vehicleId, status: "READY", hermesRequestId: requestId },
        data: { hermesDispatchedAt: null },
      });

      const attemptsAllowed = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attemptsAllowed;
      const message = err instanceof HermesTriggerError ? err.message : String(err);
      await prisma.vehicleEvent.create({
        data: {
          vehicleId,
          type: "HERMES_TRIGGER_FAILED",
          message: `${message} (attempt ${job.attemptsMade + 1}/${attemptsAllowed})`,
        },
      });
      if (isFinalAttempt) {
        const updated = await transitionVehicle(prisma, vehicleId, "FAILED", {
          eventType: "HERMES_UNREACHABLE",
          message: `Could not trigger Hermes after ${attemptsAllowed} attempts`,
          data: { failureReason: `Hermes unreachable: ${message}` },
        });
        await publishVehicle(publisher, updated);
      }
      throw err;
    }

    const updated = await transitionVehicle(prisma, vehicleId, "PROCESSING", {
      eventType: "HERMES_TRIGGERED",
      message: `Hermes accepted vehicle-ready event (request ${requestId})`,
      payload: { request_id: requestId, endpoint: config.HERMES_ENDPOINT },
    });
    await publishVehicle(publisher, updated);
    logger.info({ vehicleId, requestId }, "Hermes triggered");
  };
}
