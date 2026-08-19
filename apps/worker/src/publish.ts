import type { Redis } from "ioredis";
import type { VehicleWithStore } from "@lacity/database";
import { VEHICLE_UPDATES_CHANNEL, type VehicleUpdateMessage } from "@lacity/shared";
import { logger } from "./logger";

export async function publishVehicle(publisher: Redis, vehicle: VehicleWithStore): Promise<void> {
  const message: VehicleUpdateMessage = {
    vehicleId: vehicle.id,
    vin: vehicle.vin,
    status: vehicle.status,
    storeCode: vehicle.store.code,
    updatedAt: vehicle.updatedAt.toISOString(),
  };
  try {
    await publisher.publish(VEHICLE_UPDATES_CHANNEL, JSON.stringify(message));
  } catch (err) {
    logger.warn({ err, vehicleId: vehicle.id }, "Failed to publish vehicle update");
  }
}
