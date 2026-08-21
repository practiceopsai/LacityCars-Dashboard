import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { PrismaClient } from "@lacity/database";
import type { Redis } from "ioredis";
import {
  BatchIntakeRequestSchema,
  BatchRetryRequestSchema,
  ExistingBatchRequestSchema,
  ScheduleRequestSchema,
} from "@lacity/shared";
import { HttpError } from "../middleware/error";
import { publishVehicleUpdate } from "../services/publish";
import {
  enqueueBatchFreightCheck,
  enqueueBatchHermesDispatch,
  type Queues,
} from "../services/queues";
import { intakeVehicle, resolveStore, updateMessageFor } from "../services/vehicleService";

function serializeBatch(batch: {
  id: string;
  groupKey: string;
  name: string;
  transportReference: string | null;
  status: string;
  scheduledStartAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  store: { code: string; name: string; autosoftInstance: string };
  vehicles: Array<{ status: string }>;
}) {
  const counts = batch.vehicles.reduce<Record<string, number>>((all, vehicle) => {
    all[vehicle.status] = (all[vehicle.status] ?? 0) + 1;
    return all;
  }, {});
  return {
    id: batch.id,
    groupKey: batch.groupKey,
    name: batch.name,
    transportReference: batch.transportReference,
    status: batch.status,
    scheduledStartAt: batch.scheduledStartAt.toISOString(),
    startedAt: batch.startedAt?.toISOString() ?? null,
    completedAt: batch.completedAt?.toISOString() ?? null,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    store: batch.store,
    vehicleCount: batch.vehicles.length,
    counts,
  };
}

export function batchesRouter(
  prisma: PrismaClient,
  queues: Queues,
  publisher: Redis,
  guards: { csrf: RequestHandler; limiter: RequestHandler },
): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const batches = await prisma.stockingBatch.findMany({
        include: { store: { select: { code: true, name: true, autosoftInstance: true } }, vehicles: { select: { status: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      res.json({ items: batches.map(serializeBatch) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const batch = await prisma.stockingBatch.findUnique({
        where: { id: req.params.id },
        include: {
          store: { select: { code: true, name: true, autosoftInstance: true } },
          vehicles: { orderBy: [{ batchPosition: "asc" }, { createdAt: "asc" }] },
        },
      });
      if (!batch) throw new HttpError(404, "BATCH_NOT_FOUND", "Stocking batch not found");
      res.json({ ...serializeBatch(batch), vehicles: batch.vehicles });
    } catch (error) {
      next(error);
    }
  });

  router.post("/intake", guards.limiter, guards.csrf, async (req, res, next) => {
    try {
      const input = BatchIntakeRequestSchema.parse(req.body);
      const scheduledStartAt = new Date(input.scheduledAt);
      if (scheduledStartAt.getTime() <= Date.now()) {
        throw new HttpError(400, "SCHEDULE_IN_PAST", "Batch start time must be in the future");
      }

      const resolved = await Promise.all(
        input.vehicles.map(async (vehicle, position) => ({
          vehicle,
          position,
          store: await resolveStore(prisma, vehicle.store),
        })),
      );
      const unknown = resolved.filter((item) => !item.store);
      if (unknown.length > 0) {
        throw new HttpError(
          400,
          "UNKNOWN_BATCH_STORE",
          `Unknown stores: ${[...new Set(unknown.map((item) => item.vehicle.store))].join(", ")}`,
        );
      }

      const groupKey = randomUUID();
      const results = [];
      const createdByStore = new Map<string, Array<{ vehicleId: string; position: number }>>();
      for (const item of resolved) {
        const result = await intakeVehicle(prisma, { ...item.vehicle, scheduledAt: input.scheduledAt });
        results.push(result);
        if (result.ok && !result.duplicate && result.vehicleId && item.store) {
          const rows = createdByStore.get(item.store.id) ?? [];
          rows.push({ vehicleId: result.vehicleId, position: item.position });
          createdByStore.set(item.store.id, rows);
        }
      }

      const batches = [];
      for (const [storeId, rows] of createdByStore) {
        const store = resolved.find((item) => item.store?.id === storeId)!.store!;
        const batch = await prisma.$transaction(async (tx) => {
          const created = await tx.stockingBatch.create({
            data: {
              groupKey,
              name: createdByStore.size > 1 ? `${input.name} — ${store.name}` : input.name,
              transportReference: input.transportReference ?? null,
              storeId,
              scheduledStartAt,
            },
          });
          for (const row of rows) {
            await tx.vehicle.update({
              where: { id: row.vehicleId },
              data: { stockingBatchId: created.id, batchPosition: row.position + 1 },
            });
            await tx.vehicleEvent.create({
              data: {
                vehicleId: row.vehicleId,
                type: "BATCH_ASSIGNED",
                fromStatus: "PENDING",
                toStatus: "PENDING",
                message: `Assigned to sequential batch ${created.name}`,
                payload: { batchId: created.id, groupKey, position: row.position + 1 },
              },
            });
          }
          return created;
        });
        await enqueueBatchHermesDispatch(queues, batch.id, batch.dispatchNonce, scheduledStartAt);
        await enqueueBatchFreightCheck(queues, batch.id, { attempt: 0 });
        for (const row of rows) {
          const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: row.vehicleId }, include: { store: true } });
          await publishVehicleUpdate(publisher, updateMessageFor(vehicle));
        }
        batches.push({ id: batch.id, store: store.code, vehicleCount: rows.length });
      }

      res.status(201).json({
        groupKey,
        batches,
        results,
        summary: {
          created: results.filter((result) => result.ok && !result.duplicate).length,
          duplicates: results.filter((result) => result.ok && result.duplicate).length,
          rejected: results.filter((result) => !result.ok).length,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/adopt", guards.limiter, guards.csrf, async (req, res, next) => {
    try {
      const input = ExistingBatchRequestSchema.parse(req.body);
      const vehicleIds = [...new Set(input.vehicleIds)];
      if (vehicleIds.length !== input.vehicleIds.length) {
        throw new HttpError(400, "DUPLICATE_BATCH_VEHICLE", "Each vehicle may appear only once in a batch");
      }
      const vehicles = await prisma.vehicle.findMany({
        where: { id: { in: vehicleIds } },
        include: { store: true },
      });
      if (vehicles.length !== vehicleIds.length) {
        throw new HttpError(404, "BATCH_VEHICLE_NOT_FOUND", "One or more selected vehicles were not found");
      }
      const byId = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
      const ordered = vehicleIds.map((id) => byId.get(id)!);
      const storeId = ordered[0]!.storeId;
      if (ordered.some((vehicle) => vehicle.storeId !== storeId)) {
        throw new HttpError(409, "MIXED_EXECUTION_STORES", "Existing vehicles must be batched one store at a time");
      }
      const blocked = ordered.filter(
        (vehicle) =>
          vehicle.status !== "READY" ||
          vehicle.stockingBatchId !== null ||
          vehicle.freightAmount === null ||
          vehicle.freightEvidence === null,
      );
      if (blocked.length > 0) {
        throw new HttpError(
          409,
          "VEHICLES_NOT_BATCH_READY",
          `Every selected vehicle must be unbatched, READY, and have freight evidence. Blocked: ${blocked.map((v) => v.vin).join(", ")}`,
        );
      }
      const scheduledStartAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
      const groupKey = randomUUID();
      const batch = await prisma.$transaction(async (tx) => {
        const created = await tx.stockingBatch.create({
          data: {
            groupKey,
            name: input.name,
            transportReference: input.transportReference ?? null,
            storeId,
            status: "READY",
            scheduledStartAt,
          },
        });
        for (let index = 0; index < ordered.length; index += 1) {
          const vehicle = ordered[index]!;
          await tx.vehicle.update({
            where: { id: vehicle.id },
            data: {
              stockingBatchId: created.id,
              batchPosition: index + 1,
              scheduledStartAt,
              dispatchNonce: { increment: 1 },
              hermesDispatchedAt: null,
              hermesRequestId: null,
            },
          });
          await tx.vehicleEvent.create({
            data: {
              vehicleId: vehicle.id,
              type: "EXISTING_BATCH_ASSIGNED",
              fromStatus: "READY",
              toStatus: "READY",
              message: `Moved from individual queue into sequential batch ${input.name}`,
              payload: { batchId: created.id, groupKey, position: index + 1 },
            },
          });
        }
        return created;
      });
      await enqueueBatchHermesDispatch(queues, batch.id, batch.dispatchNonce, scheduledStartAt);
      res.status(201).json({
        id: batch.id,
        groupKey,
        name: batch.name,
        store: ordered[0]!.store.code,
        vehicleCount: ordered.length,
        scheduledStartAt: scheduledStartAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/schedule", guards.limiter, guards.csrf, async (req, res, next) => {
    try {
      const body = ScheduleRequestSchema.parse(req.body);
      const scheduledStartAt = new Date(body.scheduledAt);
      if (scheduledStartAt.getTime() <= Date.now()) {
        throw new HttpError(400, "SCHEDULE_IN_PAST", "Batch start time must be in the future");
      }
      const existing = await prisma.stockingBatch.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new HttpError(404, "BATCH_NOT_FOUND", "Stocking batch not found");
      if (["PROCESSING", "COMPLETED"].includes(existing.status)) {
        throw new HttpError(409, "BATCH_NOT_SCHEDULABLE", `Batch in ${existing.status} cannot be rescheduled`);
      }
      const batch = await prisma.$transaction(async (tx) => {
        const changed = await tx.stockingBatch.update({
          where: { id: existing.id },
          data: {
            scheduledStartAt,
            status: "READY",
            dispatchNonce: { increment: 1 },
            hermesDispatchedAt: null,
            hermesRequestId: null,
          },
        });
        await tx.vehicle.updateMany({
          where: { stockingBatchId: existing.id, status: { in: ["PENDING", "AWAITING_FREIGHT", "READY"] } },
          data: { scheduledStartAt },
        });
        return changed;
      });
      await enqueueBatchHermesDispatch(queues, batch.id, batch.dispatchNonce, batch.scheduledStartAt);
      res.json({
        id: batch.id,
        status: batch.status,
        scheduledStartAt: batch.scheduledStartAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/retry", guards.limiter, guards.csrf, async (req, res, next) => {
    try {
      const body = BatchRetryRequestSchema.parse(req.body);
      const scheduledStartAt = new Date(body.scheduledAt);
      if (scheduledStartAt.getTime() <= Date.now()) {
        throw new HttpError(400, "SCHEDULE_IN_PAST", "Batch retry time must be in the future");
      }
      const existing = await prisma.stockingBatch.findUnique({
        where: { id: req.params.id },
        include: { vehicles: { orderBy: [{ batchPosition: "asc" }, { createdAt: "asc" }] } },
      });
      if (!existing) throw new HttpError(404, "BATCH_NOT_FOUND", "Stocking batch not found");
      if (existing.status === "PROCESSING") {
        throw new HttpError(409, "BATCH_STILL_PROCESSING", "Stop or fail the active batch before retrying it");
      }
      if (existing.status === "COMPLETED") {
        throw new HttpError(409, "BATCH_ALREADY_COMPLETED", "A completed batch cannot be retried");
      }
      const retryable = existing.vehicles.filter((vehicle) => vehicle.status !== "COMPLETED");
      if (retryable.length === 0) {
        throw new HttpError(409, "NO_RETRYABLE_VEHICLES", "This batch has no non-completed vehicles");
      }
      const missingFreight = retryable.filter(
        (vehicle) => vehicle.freightAmount === null || vehicle.freightEvidence === null,
      );
      if (missingFreight.length > 0) {
        throw new HttpError(
          409,
          "BATCH_RETRY_MISSING_FREIGHT",
          `Freight evidence is required before retry: ${missingFreight.map((vehicle) => vehicle.vin).join(", ")}`,
        );
      }

      const batch = await prisma.$transaction(async (tx) => {
        for (const vehicle of retryable) {
          await tx.vehicle.update({
            where: { id: vehicle.id },
            data: {
              status: "READY",
              scheduledStartAt,
              dispatchNonce: { increment: 1 },
              hermesDispatchedAt: null,
              hermesRequestId: null,
              failureReason: null,
              completedAt: null,
            },
          });
          await tx.vehicleEvent.create({
            data: {
              vehicleId: vehicle.id,
              type: "BATCH_RETRY_REQUESTED",
              fromStatus: vehicle.status,
              toStatus: "READY",
              message: body.note,
              payload: { batchId: existing.id, scheduledStartAt: scheduledStartAt.toISOString() },
            },
          });
        }
        return tx.stockingBatch.update({
          where: { id: existing.id },
          data: {
            status: "READY",
            scheduledStartAt,
            dispatchNonce: { increment: 1 },
            hermesDispatchedAt: null,
            hermesRequestId: null,
            startedAt: null,
            completedAt: null,
          },
        });
      });
      await enqueueBatchHermesDispatch(queues, batch.id, batch.dispatchNonce, batch.scheduledStartAt);
      for (const vehicle of retryable) {
        const refreshed = await prisma.vehicle.findUniqueOrThrow({
          where: { id: vehicle.id },
          include: { store: true },
        });
        await publishVehicleUpdate(publisher, updateMessageFor(refreshed));
      }
      res.json({
        id: batch.id,
        status: batch.status,
        retriedVehicleCount: retryable.length,
        scheduledStartAt: batch.scheduledStartAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
