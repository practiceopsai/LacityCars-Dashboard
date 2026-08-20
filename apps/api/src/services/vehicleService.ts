import type { PrismaClient, Prisma, Store, VehicleWithStore } from "@lacity/database";
import {
  ACTIVE_STATUSES,
  maskVin,
  matchesStore,
  validateVin,
  type VehicleStatus,
  type VehicleUpdateMessage,
} from "@lacity/shared";

export { transitionVehicle, type VehicleWithStore } from "@lacity/database";

function num(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

/** API wire shape for a vehicle. Full VIN stays available; masked form is for compact display. */
export function serializeVehicle(vehicle: VehicleWithStore) {
  return {
    id: vehicle.id,
    vin: vehicle.vin,
    vinMasked: maskVin(vehicle.vin),
    model: vehicle.model,
    status: vehicle.status,
    stockNumber: vehicle.stockNumber,
    store: {
      code: vehicle.store.code,
      name: vehicle.store.name,
      stockPrefix: vehicle.store.stockPrefix,
    },
    freightAmount: num(vehicle.freightAmount),
    freightEvidence: vehicle.freightEvidence,
    freightAttempts: vehicle.freightAttempts,
    nextFreightCheckAt: vehicle.nextFreightCheckAt?.toISOString() ?? null,
    scheduledStartAt: vehicle.scheduledStartAt?.toISOString() ?? null,
    acv: num(vehicle.acv),
    finalTotal: num(vehicle.finalTotal),
    ragCommitId: vehicle.ragCommitId,
    failureReason: vehicle.failureReason,
    runSummary: vehicle.runSummary,
    completedAt: vehicle.completedAt?.toISOString() ?? null,
    createdAt: vehicle.createdAt.toISOString(),
    updatedAt: vehicle.updatedAt.toISOString(),
  };
}

export function updateMessageFor(vehicle: VehicleWithStore): VehicleUpdateMessage {
  return {
    vehicleId: vehicle.id,
    vin: vehicle.vin,
    status: vehicle.status,
    storeCode: vehicle.store.code,
    updatedAt: vehicle.updatedAt.toISOString(),
  };
}

/** Resolve operator store input (code, name, or alias) against active stores. */
export async function resolveStore(prisma: PrismaClient, input: string): Promise<Store | null> {
  const stores = await prisma.store.findMany({ where: { active: true } });
  return (
    stores.find((s) =>
      matchesStore(
        {
          code: s.code,
          name: s.name,
          aliases: s.aliases,
          stockPrefix: s.stockPrefix,
          autosoftInstance: s.autosoftInstance,
          internalCharges: [],
          chargesTotal: s.chargesTotal,
        },
        input,
      ),
    ) ?? null
  );
}

export interface IntakeItemResult {
  vin: string;
  ok: boolean;
  vehicleId?: string;
  duplicate?: boolean;
  status?: VehicleStatus;
  errors?: string[];
}

/**
 * Intake one vehicle. Idempotent per active Store+VIN: an existing active
 * record is returned instead of creating a duplicate.
 */
export async function intakeVehicle(
  prisma: PrismaClient,
  input: { store: string; vin: string; model: string; stockNumber?: string; scheduledAt: string },
): Promise<IntakeItemResult> {
  const vinCheck = validateVin(input.vin);
  if (!vinCheck.ok || !vinCheck.vin) {
    return { vin: input.vin, ok: false, errors: vinCheck.errors };
  }
  const vin = vinCheck.vin;
  const scheduledStartAt = new Date(input.scheduledAt);
  if (scheduledStartAt.getTime() <= Date.now()) {
    return { vin, ok: false, errors: ["Scheduled stocking time must be in the future"] };
  }

  const store = await resolveStore(prisma, input.store);
  if (!store) {
    return { vin, ok: false, errors: [`Unknown store "${input.store}"`] };
  }

  const existing = await prisma.vehicle.findFirst({
    where: { storeId: store.id, vin, status: { in: [...ACTIVE_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return { vin, ok: true, vehicleId: existing.id, duplicate: true, status: existing.status };
  }

  const vehicle = await prisma.vehicle.create({
    data: {
      storeId: store.id,
      vin,
      model: input.model,
      stockNumber: input.stockNumber ?? null,
      scheduledStartAt,
      status: "PENDING",
      events: {
        create: {
          type: "INTAKE",
          toStatus: "PENDING",
          message: `Intake accepted for ${store.name}; Hermes scheduled for ${scheduledStartAt.toISOString()}`,
          payload: {
            model: input.model,
            stockNumber: input.stockNumber ?? null,
            scheduledStartAt: scheduledStartAt.toISOString(),
          },
        },
      },
    },
  });
  return { vin, ok: true, vehicleId: vehicle.id, duplicate: false, status: vehicle.status };
}
