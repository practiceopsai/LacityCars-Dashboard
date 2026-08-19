import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import { transitionVehicle, type PrismaClient } from "@lacity/database";
import type { HermesTriggerPayload, InternalCharge } from "@lacity/shared";
import type { WorkerConfig } from "../config";
import { HermesTriggerError, triggerHermes } from "../hermesClient";
import { logger } from "../logger";
import { publishVehicle } from "../publish";
import type { HermesJobData } from "../queues";

export interface HermesDeps {
  prisma: PrismaClient;
  config: WorkerConfig;
  publisher: Redis;
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
  const { prisma, config, publisher } = deps;

  return async (job: Job<HermesJobData>): Promise<void> => {
    const { vehicleId } = job.data;
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { store: true, corrections: { orderBy: { createdAt: "asc" } } },
    });
    if (!vehicle) {
      logger.warn({ vehicleId }, "Hermes dispatch for unknown vehicle; dropping");
      return;
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

    await prisma.vehicleEvent.create({
      data: {
        vehicleId,
        type: "HERMES_TRIGGERED",
        message: `Hermes triggered (request ${requestId})`,
        payload: { request_id: requestId, endpoint: config.HERMES_ENDPOINT },
      },
    });
    const fresh = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
      include: { store: true },
    });
    await publishVehicle(publisher, fresh);
    logger.info({ vehicleId, requestId }, "Hermes triggered");
  };
}
