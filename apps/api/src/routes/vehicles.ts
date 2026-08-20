import { Router, type RequestHandler } from "express";
import type { PrismaClient, Prisma } from "@lacity/database";
import type { Redis } from "ioredis";
import { z } from "zod";
import {
  IntakeRequestSchema,
  RETRYABLE_STATUSES,
  RetryRequestSchema,
  ScheduleRequestSchema,
  CorrectionRequestSchema,
  isVehicleStatus,
  normalizeVin,
  type VehicleStatus,
} from "@lacity/shared";
import { HttpError } from "../middleware/error";
import { publishVehicleUpdate } from "../services/publish";
import {
  enqueueBatchHermesDispatch,
  enqueueFreightCheck,
  enqueueHermesDispatch,
  type Queues,
} from "../services/queues";
import {
  intakeVehicle,
  serializeVehicle,
  transitionVehicle,
  updateMessageFor,
} from "../services/vehicleService";

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  store: z.string().trim().optional(),
  status: z.string().trim().optional(),
  search: z.string().trim().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function buildWhere(query: z.infer<typeof ListQuerySchema>): Prisma.VehicleWhereInput {
  const where: Prisma.VehicleWhereInput = {};
  if (query.store) where.store = { code: query.store };
  if (query.status) {
    if (!isVehicleStatus(query.status)) {
      throw new HttpError(400, "INVALID_STATUS", `Unknown status "${query.status}"`);
    }
    where.status = query.status;
  }
  if (query.search) {
    const needle = query.search;
    where.OR = [
      { vin: { contains: normalizeVin(needle) } },
      { stockNumber: { contains: needle, mode: "insensitive" } },
      { model: { contains: needle, mode: "insensitive" } },
    ];
  }
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }
  return where;
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function futureSchedule(value: string): Date {
  const scheduledAt = new Date(value);
  if (scheduledAt.getTime() <= Date.now()) {
    throw new HttpError(400, "SCHEDULE_IN_PAST", "Scheduled stocking time must be in the future");
  }
  return scheduledAt;
}

export function vehiclesRouter(
  prisma: PrismaClient,
  queues: Queues,
  publisher: Redis,
  guards: { csrf: RequestHandler; limiter: RequestHandler },
): Router {
  const router = Router();

  /** POST /api/vehicles/intake — one or many; idempotent for active Store+VIN. */
  router.post("/intake", guards.limiter, guards.csrf, async (req, res, next) => {
    try {
      const parsed = IntakeRequestSchema.parse(req.body);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const results = [];
      for (const item of items) {
        const result = await intakeVehicle(prisma, item);
        if (result.ok && result.vehicleId && !result.duplicate) {
          await enqueueFreightCheck(queues, result.vehicleId, { nonce: 0, attempt: 0 });
          const vehicle = await prisma.vehicle.findUniqueOrThrow({
            where: { id: result.vehicleId },
            include: { store: true },
          });
          await publishVehicleUpdate(publisher, updateMessageFor(vehicle));
        }
        results.push(result);
      }
      res.status(200).json({
        results,
        summary: {
          created: results.filter((r) => r.ok && !r.duplicate).length,
          duplicates: results.filter((r) => r.ok && r.duplicate).length,
          rejected: results.filter((r) => !r.ok).length,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/vehicles — pagination + store/status/search filters. */
  router.get("/", async (req, res, next) => {
    try {
      const query = ListQuerySchema.parse(req.query);
      const where = buildWhere(query);
      const [total, vehicles] = await Promise.all([
        prisma.vehicle.count({ where }),
        prisma.vehicle.findMany({
          where,
          include: { store: true },
          orderBy: { updatedAt: "desc" },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);
      res.json({
        items: vehicles.map(serializeVehicle),
        total,
        page: query.page,
        pageSize: query.pageSize,
      });
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/vehicles/export.csv — Excel-friendly ledger export (BOM + CRLF). */
  router.get("/export.csv", async (req, res, next) => {
    try {
      const query = ListQuerySchema.parse({ ...req.query, page: 1, pageSize: 100 });
      const where = buildWhere({ ...query, status: query.status ?? "COMPLETED" });
      const vehicles = await prisma.vehicle.findMany({
        where,
        include: { store: true },
        orderBy: { completedAt: "desc" },
        take: 10_000,
      });
      const header = [
        "Stock #",
        "VIN",
        "Store",
        "Model",
        "Completed",
        "ACV",
        "Freight",
        "Final Total",
        "RAG Commit",
      ];
      const lines = [header.join(",")];
      for (const v of vehicles) {
        const s = serializeVehicle(v);
        lines.push(
          [
            csvCell(s.stockNumber),
            csvCell(s.vin),
            csvCell(s.store.name),
            csvCell(s.model),
            csvCell(s.completedAt ?? ""),
            csvCell(s.acv),
            csvCell(s.freightAmount),
            csvCell(s.finalTotal),
            csvCell(s.ragCommitId),
          ].join(","),
        );
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="completed-ledger.csv"');
      res.send("﻿" + lines.join("\r\n") + "\r\n");
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/vehicles/:id — details + timeline. */
  router.get("/:id", async (req, res, next) => {
    try {
      const vehicle = await prisma.vehicle.findUnique({
        where: { id: req.params.id },
        include: {
          store: true,
          events: { orderBy: { createdAt: "asc" } },
          corrections: { orderBy: { createdAt: "asc" } },
        },
      });
      if (!vehicle) throw new HttpError(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
      res.json({
        ...serializeVehicle(vehicle),
        timeline: vehicle.events.map((e) => ({
          id: e.id,
          type: e.type,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          message: e.message,
          payload: e.payload,
          createdAt: e.createdAt.toISOString(),
        })),
        corrections: vehicle.corrections.map((c) => ({
          id: c.id,
          note: c.note,
          fields: c.fields,
          createdBy: c.createdBy,
          createdAt: c.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/vehicles/:id/retry — requires a note; requeues eligible vehicles. */
  router.post("/:id/retry", guards.limiter, guards.csrf, async (req, res, next) => {
    try {
      const body = RetryRequestSchema.parse(req.body);
      const vehicle = await prisma.vehicle.findUnique({
        where: { id: req.params.id },
        include: { store: true },
      });
      if (!vehicle) throw new HttpError(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
      if (!RETRYABLE_STATUSES.includes(vehicle.status as VehicleStatus)) {
        throw new HttpError(
          409,
          "VEHICLE_NOT_RETRYABLE",
          `Vehicles in ${vehicle.status} cannot be retried`,
        );
      }

      await prisma.correction.create({
        data: {
          vehicleId: vehicle.id,
          note: body.note,
          fields: body.corrections ?? undefined,
        },
      });

      const nonce = vehicle.dispatchNonce + 1;
      const scheduledStartAt = body.scheduledAt
        ? futureSchedule(body.scheduledAt)
        : vehicle.scheduledStartAt;
      if (!scheduledStartAt) {
        throw new HttpError(400, "SCHEDULE_REQUIRED", "Assign a stocking time before retrying");
      }
      const hasFreight = vehicle.freightAmount !== null;
      const target: VehicleStatus = hasFreight ? "READY" : "AWAITING_FREIGHT";
      const updated = await transitionVehicle(prisma, vehicle.id, target, {
        eventType: "RETRY_REQUESTED",
        message: body.note,
        payload: { corrections: body.corrections ?? null },
        data: {
          dispatchNonce: nonce,
          scheduledStartAt,
          hermesDispatchedAt: null,
          failureReason: null,
          ...(hasFreight ? {} : { freightAttempts: 0, nextFreightCheckAt: new Date() }),
        },
      });
      if (hasFreight) {
        if (vehicle.stockingBatchId) {
          const batch = await prisma.stockingBatch.update({
            where: { id: vehicle.stockingBatchId },
            data: {
              status: "READY",
              dispatchNonce: { increment: 1 },
              hermesDispatchedAt: null,
              hermesRequestId: null,
              ...(body.scheduledAt ? { scheduledStartAt } : {}),
            },
          });
          await enqueueBatchHermesDispatch(
            queues,
            batch.id,
            batch.dispatchNonce,
            batch.scheduledStartAt,
          );
        } else {
          await enqueueHermesDispatch(queues, vehicle.id, nonce, scheduledStartAt);
        }
      } else {
        await enqueueFreightCheck(queues, vehicle.id, { nonce, attempt: 0 });
      }
      await publishVehicleUpdate(publisher, updateMessageFor(updated));
      res.json({ vehicle: serializeVehicle(updated), requeuedAs: target });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/vehicles/:id/schedule — reschedule queued work without touching live systems. */
  router.post("/:id/schedule", guards.limiter, guards.csrf, async (req, res, next) => {
    try {
      const body = ScheduleRequestSchema.parse(req.body);
      const scheduledStartAt = futureSchedule(body.scheduledAt);
      const vehicle = await prisma.vehicle.findUnique({
        where: { id: req.params.id },
        include: { store: true },
      });
      if (!vehicle) throw new HttpError(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
      if (vehicle.stockingBatchId) {
        throw new HttpError(
          409,
          "BATCH_MANAGED_SCHEDULE",
          "This vehicle belongs to a store batch; reschedule the batch so every child keeps the same AutoSoft window",
        );
      }
      if (!["PENDING", "AWAITING_FREIGHT", "READY"].includes(vehicle.status)) {
        throw new HttpError(
          409,
          "VEHICLE_NOT_SCHEDULABLE",
          `Vehicles in ${vehicle.status} cannot be rescheduled`,
        );
      }

      const nonce = vehicle.dispatchNonce + 1;
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.vehicle.update({
          where: { id: vehicle.id },
          data: {
            scheduledStartAt,
            dispatchNonce: nonce,
            hermesDispatchedAt: null,
            hermesRequestId: null,
          },
          include: { store: true },
        });
        await tx.vehicleEvent.create({
          data: {
            vehicleId: vehicle.id,
            type: "STOCKING_RESCHEDULED",
            fromStatus: vehicle.status,
            toStatus: vehicle.status,
            message: `Hermes start rescheduled for ${scheduledStartAt.toISOString()}`,
            payload: { scheduledStartAt: scheduledStartAt.toISOString(), dispatchNonce: nonce },
          },
        });
        return changed;
      });

      if (vehicle.status === "READY") {
        await enqueueHermesDispatch(queues, vehicle.id, nonce, scheduledStartAt);
      } else {
        await enqueueFreightCheck(queues, vehicle.id, { nonce, attempt: vehicle.freightAttempts });
      }
      await publishVehicleUpdate(publisher, updateMessageFor(updated));
      res.json({ vehicle: serializeVehicle(updated) });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/vehicles/:id/corrections — recorded and surfaced to the Hermes trigger context. */
  router.post("/:id/corrections", guards.limiter, guards.csrf, async (req, res, next) => {
    try {
      const body = CorrectionRequestSchema.parse(req.body);
      const vehicle = await prisma.vehicle.findUnique({
        where: { id: req.params.id },
        include: { store: true },
      });
      if (!vehicle) throw new HttpError(404, "VEHICLE_NOT_FOUND", "Vehicle not found");

      const correction = await prisma.correction.create({
        data: { vehicleId: vehicle.id, note: body.note, fields: body.fields ?? undefined },
      });
      await prisma.vehicleEvent.create({
        data: {
          vehicleId: vehicle.id,
          type: "CORRECTION_ADDED",
          message: body.note,
          payload: { fields: body.fields ?? null },
        },
      });
      await publishVehicleUpdate(publisher, updateMessageFor(vehicle));
      res.status(201).json({
        id: correction.id,
        note: correction.note,
        fields: correction.fields,
        createdAt: correction.createdAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
