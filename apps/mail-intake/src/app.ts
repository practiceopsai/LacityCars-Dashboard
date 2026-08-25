import express, { type Request } from "express";
import { z } from "zod";
import type { Queue } from "bullmq";
import type { MailIntakeConfig } from "./config";
import { logger } from "./logger";
import { verifySvixSignature } from "./svix";
import { verifyExtractionCallback } from "./extract/pdfHermes";
import type { MailIntakeJobData } from "./queues";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/** Payload the AgentMail (Svix) webhook delivers for message events. */
const WebhookEventSchema = z.object({
  event_type: z.string().optional(),
  type: z.string().optional(),
  message_id: z.string().optional(),
  message: z.object({ message_id: z.string() }).partial().optional(),
});

/** Rows the Hermes extraction agent posts back. */
const ExtractionCallbackSchema = z.object({
  request_id: z.string().min(1),
  vehicles: z
    .array(
      z.object({
        vin: z.string().min(1),
        model: z.string().nullish(),
        store: z.string().nullish(),
        source: z.string().nullish(),
        stock_number: z.string().nullish(),
        page: z.union([z.number(), z.string()]).nullish(),
      }),
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
});

export function createApp(config: MailIntakeConfig, queue: Queue<MailIntakeJobData>) {
  const app = express();
  app.use(
    express.json({
      limit: "2mb",
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );

  app.get("/ready", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/webhooks/agentmail", (req: RawBodyRequest, res) => {
    const verdict = verifySvixSignature(
      req.rawBody ?? Buffer.alloc(0),
      {
        id: req.header("svix-id"),
        timestamp: req.header("svix-timestamp"),
        signature: req.header("svix-signature"),
      },
      config.AGENTMAIL_WEBHOOK_SECRET,
      Date.now(),
      config.WEBHOOK_TOLERANCE_MS,
    );
    if (!verdict.ok) {
      logger.warn({ reason: verdict.reason }, "Rejected AgentMail webhook");
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    const parsed = WebhookEventSchema.safeParse(req.body);
    const eventType = parsed.success ? (parsed.data.event_type ?? parsed.data.type ?? "") : "";
    const messageId = parsed.success
      ? (parsed.data.message_id ?? parsed.data.message?.message_id)
      : undefined;

    if (!eventType.includes("message.received") || !messageId) {
      res.status(202).json({ ignored: true });
      return;
    }

    // Ack immediately; the queue does the work. jobId dedupes redeliveries.
    void queue
      .add("message", { kind: "message", messageId }, { jobId: `msg:${messageId}` })
      .catch((err) => logger.error({ err, messageId }, "Failed to enqueue message job"));
    res.status(202).json({ accepted: true });
  });

  app.post("/callbacks/extraction", (req: RawBodyRequest, res) => {
    const valid = verifyExtractionCallback(
      req.rawBody ?? Buffer.alloc(0),
      req.header("x-webhook-timestamp"),
      req.header("x-webhook-signature-v2"),
      config.EXTRACTION_CALLBACK_SECRET,
    );
    if (!valid) {
      logger.warn("Rejected extraction callback (bad signature)");
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    const parsed = ExtractionCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid payload" });
      return;
    }
    const { request_id, vehicles, warnings } = parsed.data;
    void queue
      .add(
        "finalize",
        {
          kind: "finalize",
          messageId: request_id,
          pdfRows: vehicles.map((v) => ({
            vin: v.vin,
            model: v.model ?? null,
            store: v.store ?? null,
            source: v.source ?? null,
            stockNumber: v.stock_number ?? null,
            origin: `PDF${v.page ? ` page ${v.page}` : ""}`,
          })),
          pdfWarnings: warnings,
        },
        { jobId: `finalize:${request_id}` },
      )
      .catch((err) => logger.error({ err, request_id }, "Failed to enqueue finalize job"));
    res.json({ status: "accepted" });
  });

  return app;
}
