import type { Prisma, PrismaClient, Store, Vehicle } from "@prisma/client";
import { assertTransition, type VehicleStatus } from "@lacity/shared";

export type VehicleWithStore = Vehicle & { store: Store };

export interface TransitionOptions {
  eventType: string;
  message?: string;
  payload?: Prisma.InputJsonValue;
  data?: Prisma.VehicleUpdateInput;
}

/**
 * Transition a vehicle with state-machine enforcement, writing an immutable
 * timeline event in the same transaction. Throws InvalidTransitionError on
 * violations. Shared by the API and the worker.
 */
export async function transitionVehicle(
  prisma: PrismaClient,
  vehicleId: string,
  to: VehicleStatus,
  options: TransitionOptions,
): Promise<VehicleWithStore> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    assertTransition(current.status as VehicleStatus, to);
    const updated = await tx.vehicle.update({
      where: { id: vehicleId },
      data: { ...options.data, status: to },
      include: { store: true },
    });
    await tx.vehicleEvent.create({
      data: {
        vehicleId,
        type: options.eventType,
        fromStatus: current.status,
        toStatus: to,
        message: options.message ?? null,
        payload: options.payload,
      },
    });
    return updated;
  });
}
