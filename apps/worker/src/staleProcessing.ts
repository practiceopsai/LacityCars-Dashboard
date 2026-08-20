import { transitionVehicle, type PrismaClient, type VehicleWithStore } from "@lacity/database";
import type { Redis } from "ioredis";
import { logger } from "./logger";
import { publishVehicle } from "./publish";

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
