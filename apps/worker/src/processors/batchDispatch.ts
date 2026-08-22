import { DelayedError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@lacity/database";
import {
  stockingScheduleLabels,
  type HermesBatchTriggerPayload,
  type InternalCharge,
} from "@lacity/shared";
import type { WorkerConfig } from "../config";
import { acquireDesktopDispatchLock } from "../desktopDispatchLock";
import { triggerHermes } from "../hermesClient";
import { logger } from "../logger";
import type { HermesJobData } from "../queues";

interface BatchDispatchDeps {
  prisma: PrismaClient;
  config: WorkerConfig;
  publisher: Redis;
}

// Live observation on the shared AutoSoft desktop showed that two complete
// vehicle posts fit Hermes's 500-action ceiling reliably. A third record can
// strand an already-created stock shell before its terminal callback. Keep
// execution windows at two; continuation jobs reuse the same store batch,
// sheet rows, source export, and AutoSoft instance without mixing stores.
export const HERMES_BATCH_WINDOW = 2;
// Hermes caps an individual rendered template value at 2,000 characters and
// pretty-prints object/array substitutions. Budget the compact JSON much lower
// so indentation and newline expansion cannot truncate a child record.
export const HERMES_VEHICLES_JSON_LIMIT = 1_200;

/**
 * The desktop agent only needs the defensible freight calculation, not a copy
 * of every dispatch row/VIN. Sending the raw workbook evidence made the
 * Hermes webhook exceed its prompt limit and silently truncated a seven-car
 * batch after vehicle two.
 */
export function compactFreightEvidence(value: unknown): Record<string, unknown> {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    loadId: source.loadId ?? source.load_id ?? null,
    loadPrice: source.loadPrice ?? source.load_price ?? null,
    distinctVinCount: source.distinctVinCount ?? source.distinct_vin_count ?? null,
    matchedRowNumbers: Array.isArray(source.matchedRowNumbers)
      ? source.matchedRowNumbers.slice(0, 4)
      : Array.isArray(source.matched_row_numbers)
        ? source.matched_row_numbers.slice(0, 4)
        : [],
    fetchedAt: source.fetchedAt ?? source.fetched_at ?? null,
  };
}

export function compactCorrections(
  corrections: Array<{ note: string; fields: unknown; createdAt: Date }>,
) {
  return corrections.slice(-1).map((correction) => {
    const rawFields =
      typeof correction.fields === "object" && correction.fields !== null
        ? Object.entries(correction.fields as Record<string, unknown>).slice(0, 6)
        : [];
    return {
      note: correction.note.slice(0, 160),
      fields:
        rawFields.length === 0
          ? null
          : Object.fromEntries(rawFields.map(([key, value]) => [key, String(value).slice(0, 100)])),
      created_at: correction.createdAt.toISOString(),
    };
  });
}

export function fitHermesVehicleManifest<T>(records: T[]): T[] {
  const selected: T[] = [];
  for (const record of records) {
    const candidate = [...selected, record];
    if (
      selected.length > 0 &&
      JSON.stringify(candidate).length > HERMES_VEHICLES_JSON_LIMIT
    ) {
      break;
    }
    selected.push(record);
  }
  return selected;
}

/**
 * Claims all READY vehicles in one store batch and sends one Hermes run.
 * Hermes updates the sheet in one pass, retains the AutoSoft session, and
 * checkpoints each vehicle through the existing per-VIN callback endpoint.
 */
export function createBatchDispatchProcessor(deps: BatchDispatchDeps) {
  const { prisma, config, publisher } = deps;

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

    const desktopLock = await acquireDesktopDispatchLock(
      publisher,
      `batch:${batchId}:${job.id ?? nonce}`,
    );
    if (!desktopLock) {
      await job.moveToDelayed(Date.now() + config.HERMES_BUSY_DELAY_MS, token);
      logger.info({ batchId }, "Hermes desktop claim busy; batch dispatch delayed");
      throw new DelayedError();
    }

    try {

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

    const eligible = batch.vehicles
      .filter(
        (vehicle) =>
          vehicle.status === "READY" &&
          vehicle.hermesDispatchedAt === null &&
          vehicle.freightAmount !== null &&
          vehicle.freightEvidence !== null,
      )
      .slice(0, HERMES_BATCH_WINDOW);
    if (eligible.length === 0) {
      await prisma.stockingBatch.update({
        where: { id: batchId },
        data: { status: batch.vehicles.some((v) => v.status === "AWAITING_FREIGHT") ? "PARTIAL" : batch.status },
      });
      logger.info({ batchId }, "Batch has no dispatchable vehicles; waiting for freight/operator action");
      return;
    }

    const batchRequestId = `${batch.id}:${batch.dispatchNonce}`;
    const manifestCandidates = eligible.map((vehicle, index) => ({
      request_id: `${batchRequestId}:${index + 1}:${vehicle.id}`,
      vin: vehicle.vin,
      model: vehicle.model,
      stock_number: vehicle.stockNumber,
      freight: {
        amount: Number(vehicle.freightAmount),
        evidence: compactFreightEvidence(vehicle.freightEvidence),
      },
      corrections: compactCorrections(vehicle.corrections),
    }));
    const manifest = fitHermesVehicleManifest(manifestCandidates);
    const ready = eligible.slice(0, manifest.length);
    const requestIds = new Map(
      ready.map((vehicle, index) => [vehicle.id, manifest[index]!.request_id]),
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
        vehicle_count: ready.length,
      },
      schedule: {
        starts_at: batch.scheduledStartAt.toISOString(),
        ...stockingScheduleLabels(batch.scheduledStartAt),
      },
      store: {
        code: batch.store.code,
        name: batch.store.name,
        autosoft_instance: batch.store.autosoftInstance,
        rdp_window_title: batch.store.rdpWindowTitle,
        stock_prefix: batch.store.stockPrefix,
        internal_charges: batch.store.internalCharges as unknown as InternalCharge[],
        charges_total: batch.store.chargesTotal,
      },
      vehicles: manifest,
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
    } finally {
      await desktopLock.release();
    }
  };
}
