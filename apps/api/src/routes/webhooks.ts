import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { PrismaClient, Prisma } from "@lacity/database";
import type { Redis } from "ioredis";
import {
  ACTIVE_STATUSES,
  canTransition,
  HermesCallbackSchema,
  hermesStatusToVehicleStatus,
  HERMES_DELIVERY_HEADER,
  HERMES_SIGNATURE_HEADER,
  normalizeVin,
  type VehicleStatus,
} from "@lacity/shared";
import type { ApiConfig } from "../config";
import { logger } from "../logger";
import { publishVehicleUpdate } from "../services/publish";
import { serializeVehicle, transitionVehicle, updateMessageFor } from "../services/vehicleService";
import { verifyWebhookSignature, webhookDedupeKey } from "../services/webhookAuth";

/**
 * POST /api/webhooks/hermes
 * - HMAC-authenticated (constant-time), see docs/hermes-contract.md
 * - Every callback stored as an immutable WebhookEvent (even invalid ones)
 * - Idempotent via unique dedupe key
 * - State transitions enforced against the canonical state machine
 */
export function webhooksRouter(prisma: PrismaClient, config: ApiConfig, publisher: Redis): Router {
  const router = Router();

  router.post("/hermes", async (req, res, next) => {
    try {
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      const signature = req.headers[HERMES_SIGNATURE_HEADER] as string | undefined;
      const delivery = req.headers[HERMES_DELIVERY_HEADER] as string | undefined;

      if (!verifyWebhookSignature(raw, signature, config.HERMES_WEBHOOK_SECRET)) {
        // Record the attempt without occupying the real dedupe key, so a later
        // correctly-signed delivery with the same delivery ID still applies.
        await prisma.webhookEvent.create({
          data: {
            dedupeKey: `invalid:${randomUUID()}`,
            payload: { bodyLength: raw.length },
            signatureValid: false,
            rejectReason: "INVALID_SIGNATURE",
          },
        });
        res.status(401).json({
          error: { code: "INVALID_SIGNATURE", message: "Webhook signature verification failed", requestId: req.requestId },
        });
        return;
      }

      const dedupeKey = webhookDedupeKey(raw, delivery);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.toString("utf8"));
      } catch {
        await prisma.webhookEvent.create({
          data: {
            dedupeKey,
            payload: { rawBody: raw.toString("utf8").slice(0, 10_000) },
            signatureValid: true,
            rejectReason: "INVALID_JSON",
          },
        });
        res.status(400).json({
          error: { code: "INVALID_JSON", message: "Body is not valid JSON", requestId: req.requestId },
        });
        return;
      }

      // Immutable storage first; a unique-key collision means we already
      // processed this delivery — idempotent success.
      let event;
      try {
        event = await prisma.webhookEvent.create({
          data: { dedupeKey, payload: parsedJson as Prisma.InputJsonValue, signatureValid: true },
        });
      } catch (err) {
        const isDuplicate =
          typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
        if (isDuplicate) {
          const existing = await prisma.webhookEvent.findUnique({ where: { dedupeKey } });
          res.status(200).json({ status: "duplicate", applied: existing?.applied ?? false });
          return;
        }
        throw err;
      }

      const parsed = HermesCallbackSchema.safeParse(parsedJson);
      if (!parsed.success) {
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: { rejectReason: "SCHEMA_VALIDATION", processedAt: new Date() },
        });
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Callback failed schema validation",
            details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            requestId: req.requestId,
          },
        });
        return;
      }
      const callback = parsed.data;

      // Locate the vehicle: request ID first (exact), then newest active VIN match.
      const vin = normalizeVin(callback.vin);
      let vehicle = callback.request_id
        ? await prisma.vehicle.findUnique({
            where: { hermesRequestId: callback.request_id },
            include: { store: true },
          })
        : null;
      if (!vehicle) {
        vehicle = await prisma.vehicle.findFirst({
          where: { vin, status: { in: [...ACTIVE_STATUSES] } },
          orderBy: { createdAt: "desc" },
          include: { store: true },
        });
      }
      if (!vehicle) {
        vehicle = await prisma.vehicle.findFirst({
          where: { vin },
          orderBy: { createdAt: "desc" },
          include: { store: true },
        });
      }
      if (!vehicle) {
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: {
            requestId: callback.request_id ?? null,
            vin,
            status: callback.status,
            rejectReason: "VEHICLE_NOT_FOUND",
            processedAt: new Date(),
          },
        });
        res.status(404).json({
          error: { code: "VEHICLE_NOT_FOUND", message: `No vehicle for VIN ${vin}`, requestId: req.requestId },
        });
        return;
      }

      const from = vehicle.status as VehicleStatus;
      const to = hermesStatusToVehicleStatus(callback.status);

      if (!canTransition(from, to)) {
        const alreadyThere = from === to;
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: {
            vehicleId: vehicle.id,
            requestId: callback.request_id ?? null,
            vin,
            status: callback.status,
            rejectReason: alreadyThere ? "ALREADY_IN_STATE" : `INVALID_TRANSITION:${from}->${to}`,
            processedAt: new Date(),
          },
        });
        if (alreadyThere) {
          res.status(200).json({ status: "already_in_state", vehicleId: vehicle.id, state: from });
        } else {
          res.status(409).json({
            error: {
              code: "INVALID_TRANSITION",
              message: `Cannot move vehicle from ${from} to ${to}`,
              requestId: req.requestId,
            },
          });
        }
        return;
      }

      // Apply callback data. Our computed freight remains the source of truth;
      // Hermes-reported freight is preserved in the immutable payload and, when
      // it disagrees, in the timeline event message.
      const data: Prisma.VehicleUpdateInput = {};
      if (callback.stock_number) data.stockNumber = callback.stock_number;
      if (callback.final_total != null) data.finalTotal = callback.final_total;
      if (callback.acv != null) data.acv = callback.acv;
      if (callback.rag_commit_id) data.ragCommitId = callback.rag_commit_id;
      if (callback.run_summary) data.runSummary = callback.run_summary;
      if (to === "FAILED" || to === "ACTION_REQUIRED") {
        data.failureReason = callback.failure_reason ?? "Hermes reported failure without a reason";
      }
      if (to === "COMPLETED") {
        data.completedAt = new Date();
        data.failureReason = null;
      }

      const ourFreight = vehicle.freightAmount === null ? null : Number(vehicle.freightAmount);
      const freightMismatch =
        callback.freight_amount != null &&
        ourFreight !== null &&
        Math.abs(callback.freight_amount - ourFreight) > 0.01;

      const updated = await transitionVehicle(prisma, vehicle.id, to, {
        eventType: "HERMES_CALLBACK",
        message: freightMismatch
          ? `Hermes reported ${callback.status}; WARNING: Hermes freight ${callback.freight_amount} differs from computed ${ourFreight}`
          : `Hermes reported ${callback.status}`,
        payload: parsedJson as Prisma.InputJsonValue,
        data,
      });

      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          vehicleId: vehicle.id,
          requestId: callback.request_id ?? null,
          vin,
          status: callback.status,
          applied: true,
          processedAt: new Date(),
        },
      });

      await publishVehicleUpdate(publisher, updateMessageFor(updated));
      logger.info(
        { vehicleId: vehicle.id, from, to, requestId: req.requestId },
        "Applied Hermes callback",
      );
      res.status(200).json({ status: "applied", vehicle: serializeVehicle(updated), from, to });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
