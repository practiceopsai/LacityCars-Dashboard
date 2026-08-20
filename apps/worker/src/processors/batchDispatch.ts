import { DelayedError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@lacity/database";
import {
  stockingScheduleLabels,
  type HermesBatchTriggerPayload,
  type InternalCharge,
} from "@lacity/shared";
import type { WorkerConfig } from "../config";
import { triggerHermes } from "../hermesClient";
import { logger } from "../logger";
import type { HermesJobData } from "../queues";

interface BatchDispatchDeps {
  prisma: PrismaClient;
  config: WorkerConfig;
  publisher: Redis;
}

/**
 * Claims all READY vehicles in one store batch and sends one Hermes run.
 * Hermes updates the sheet in one pass, retains the AutoSoft session, and
 * checkpoints each vehicle through the existing per-VIN callback endpoint.
 */
export function createBatchDispatchProcessor(deps: BatchDispatchDeps) {
  const { prisma, config } = deps;

  return async (job: Job<HermesJobData>, token?: string): Promise<void> => {
    const { batchId, nonce } = job.data;
    if (!batchId) {
      logger.warn({ jobId: job.id }, "Batch Hermes job missing batchId; dropping");
      return;
    }

    const batch = await prisma.stockingBatch.findUnique({
      where: { id: batchId },
      include: {
        store: true,
        vehicles: {
          include: { corrections: { orderBy: { createdAt: "asc" } } },
          orderBy: [{ batchPosition: "asc" }, { createdAt: "asc" }],
        },
      },
    });
    if (!batch || batch.dispatchNonce !== nonce || ["COMPLETED", "FAILED"].includes(batch.status)) {
      logger.info({ batchId, jobNonce: nonce }, "Stale or terminal batch job dropped");
      return;
    }

    if (batch.scheduledStartAt.getTime() > Date.now()) {
      await job.moveToDelayed(batch.scheduledStartAt.getTime(), token);
      throw new DelayedError();
    }

    const [activeVehicle, activeBatch] = await Promise.all([
      prisma.vehicle.findFirst({ where: { status: "PROCESSING" }, select: { id: true } }),
      prisma.stockingBatch.findFirst({
        where: { status: "PROCESSING", id: { not: batchId } },
        select: { id: true },
      }),
    ]);
    if (activeVehicle || activeBatch) {
      await job.moveToDelayed(Date.now() + config.HERMES_BUSY_DELAY_MS, token);
      throw new DelayedError();
    }

    const ready = batch.vehicles.filter(
      (vehicle) =>
        vehicle.status === "READY" &&
        vehicle.hermesDispatchedAt === null &&
        vehicle.freightAmount !== null &&
        vehicle.freightEvidence !== null,
    );
    if (ready.length === 0) {
      await prisma.stockingBatch.update({
        where: { id: batchId },
        data: { status: batch.vehicles.some((v) => v.status === "AWAITING_FREIGHT") ? "PARTIAL" : batch.status },
      });
      logger.info({ batchId }, "Batch has no dispatchable vehicles; waiting for freight/operator action");
      return;
    }

    const batchRequestId = `${batch.id}:${batch.dispatchNonce}`;
    const requestIds = new Map(
      ready.map((vehicle, index) => [vehicle.id, `${batchRequestId}:${index + 1}:${vehicle.id}`]),
    );
    const claimed = await prisma.$transaction(async (tx) => {
      const batchClaim = await tx.stockingBatch.updateMany({
        where: { id: batchId, dispatchNonce: nonce, status: { in: ["PREPARING", "READY", "PARTIAL"] } },
        data: {
          status: "PROCESSING",
          hermesDispatchedAt: new Date(),
          hermesRequestId: batchRequestId,
          startedAt: new Date(),
        },
      });
      if (batchClaim.count === 0) return false;
      for (const vehicle of ready) {
        const result = await tx.vehicle.updateMany({
          where: { id: vehicle.id, status: "READY", hermesDispatchedAt: null },
          data: { hermesDispatchedAt: new Date(), hermesRequestId: requestIds.get(vehicle.id)! },
        });
        if (result.count !== 1) throw new Error(`Could not claim batch vehicle ${vehicle.id}`);
        await tx.vehicleEvent.create({
          data: {
            vehicleId: vehicle.id,
            type: "BATCH_HERMES_TRIGGERED",
            fromStatus: "READY",
            toStatus: "READY",
            message: `Included in sequential batch ${batch.name} (${batchRequestId})`,
            payload: { batchId, batchRequestId, requestId: requestIds.get(vehicle.id) },
          },
        });
      }
      return true;
    });
    if (!claimed) return;

    const payload: HermesBatchTriggerPayload = {
      request_id: batchRequestId,
      callback_url: `${config.PUBLIC_API_URL.replace(/\/$/, "")}/api/webhooks/hermes`,
      batch: {
        id: batch.id,
        group_key: batch.groupKey,
        name: batch.name,
        transport_reference: batch.transportReference,
      },
      schedule: {
        starts_at: batch.scheduledStartAt.toISOString(),
        ...stockingScheduleLabels(batch.scheduledStartAt),
      },
      store: {
        code: batch.store.code,
        name: batch.store.name,
        autosoft_instance: batch.store.autosoftInstance,
        stock_prefix: batch.store.stockPrefix,
        internal_charges: batch.store.internalCharges as unknown as InternalCharge[],
        charges_total: batch.store.chargesTotal,
      },
      vehicles: ready.map((vehicle) => ({
        request_id: requestIds.get(vehicle.id)!,
        vin: vehicle.vin,
        model: vehicle.model,
        stock_number: vehicle.stockNumber,
        freight: {
          amount: Number(vehicle.freightAmount),
          evidence: vehicle.freightEvidence as Record<string, unknown>,
        },
        corrections: vehicle.corrections.map((correction) => ({
          note: correction.note,
          fields: (correction.fields as Record<string, string> | null) ?? null,
          created_at: correction.createdAt.toISOString(),
        })),
      })),
    };

    try {
      await triggerHermes(config, payload);
      logger.info({ batchId, vehicleCount: ready.length, batchRequestId }, "Hermes batch triggered");
    } catch (error) {
      const attemptsAllowed = job.opts.attempts ?? 1;
      const finalAttempt = job.attemptsMade + 1 >= attemptsAllowed;
      await prisma.$transaction(async (tx) => {
        await tx.stockingBatch.update({
          where: { id: batchId },
          data: {
            status: finalAttempt ? "FAILED" : "READY",
            hermesDispatchedAt: null,
            hermesRequestId: null,
          },
        });
        await tx.vehicle.updateMany({
          where: { id: { in: ready.map((v) => v.id) }, status: "READY" },
          data: { hermesDispatchedAt: null, hermesRequestId: null },
        });
      });
      throw error;
    }
  };
}
