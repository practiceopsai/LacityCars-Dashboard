import type { Redis } from "ioredis";
import { VEHICLE_UPDATES_CHANNEL, type VehicleUpdateMessage } from "@lacity/shared";
import { logger } from "../logger";

/** Fan vehicle changes out over Redis pub/sub so SSE clients (and other API instances) see them. */
export async function publishVehicleUpdate(
  publisher: Redis,
  message: VehicleUpdateMessage,
): Promise<void> {
  try {
    await publisher.publish(VEHICLE_UPDATES_CHANNEL, JSON.stringify(message));
  } catch (err) {
    // Publishing is best-effort; SSE clients also poll as a fallback.
    logger.warn({ err, vehicleId: message.vehicleId }, "Failed to publish vehicle update");
  }
}
