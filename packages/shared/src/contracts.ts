import { z } from "zod";
import { validateStoreCharges } from "./stores";

/** One vehicle submitted from the intake form or a CSV row. */
export const IntakeVehicleSchema = z.object({
  store: z.string().trim().min(1, "Store is required"),
  vin: z.string().trim().min(1, "VIN is required"),
  model: z.string().trim().min(1, "Model is required").max(120),
  stockNumber: z.string().trim().max(32).optional(),
  scheduledAt: z.string().datetime({ offset: true }),
});
export type IntakeVehicle = z.infer<typeof IntakeVehicleSchema>;

/** Intake accepts one vehicle or a batch. */
export const IntakeRequestSchema = z.union([
  IntakeVehicleSchema,
  z.array(IntakeVehicleSchema).min(1).max(200),
]);
export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;

/** A transport upload is partitioned into one execution batch per store. */
export const BatchIntakeRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  transportReference: z.string().trim().max(120).optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  vehicles: z
    .array(IntakeVehicleSchema.omit({ scheduledAt: true }))
    .min(2)
    .max(200),
});
export type BatchIntakeRequest = z.infer<typeof BatchIntakeRequestSchema>;

export const HermesCallbackStatusSchema = z.enum(["PROCESSING", "COMPLETED", "FAILED"]);
export type HermesCallbackStatus = z.infer<typeof HermesCallbackStatusSchema>;

/** Payload Hermes POSTs to /api/webhooks/hermes. See docs/hermes-contract.md. */
export const HermesCallbackSchema = z.object({
  request_id: z.string().trim().min(1).optional(),
  vin: z.string().trim().min(1),
  status: HermesCallbackStatusSchema,
  stock_number: z.string().trim().max(32).optional().nullable(),
  freight_amount: z.number().nonnegative().optional().nullable(),
  final_total: z.number().nonnegative().optional().nullable(),
  acv: z.number().nonnegative().optional().nullable(),
  rag_commit_id: z.string().trim().max(200).optional().nullable(),
  failure_reason: z.string().trim().max(4000).optional().nullable(),
  run_summary: z.string().trim().max(20000).optional().nullable(),
  evidence: z.record(z.unknown()).optional().nullable(),
});
export type HermesCallback = z.infer<typeof HermesCallbackSchema>;

export const InternalChargeSchema = z.object({
  label: z.string().trim().min(1).max(60),
  amount: z.number().int().nonnegative(),
});

export const StoreUpsertSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{1,29}$/, "Code must be UPPER_SNAKE_CASE"),
    name: z.string().trim().min(2).max(80),
    aliases: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
    stockPrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,3}$/, "Stock prefix must be 1-3 uppercase characters"),
    autosoftInstance: z.string().trim().min(1).max(120),
    internalCharges: z.array(InternalChargeSchema).min(1).max(20),
    chargesTotal: z.number().int().nonnegative(),
    active: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    const result = validateStoreCharges(value.internalCharges, value.chargesTotal);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chargesTotal"],
        message: result.error ?? "Internal charges must sum to the declared total",
      });
    }
  });
export type StoreUpsert = z.infer<typeof StoreUpsertSchema>;

/** Operator retry always requires a note (and optionally structured corrections). */
export const RetryRequestSchema = z.object({
  note: z.string().trim().min(5, "A correction/note of at least 5 characters is required").max(2000),
  corrections: z.record(z.string().trim().max(500)).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
});
export type RetryRequest = z.infer<typeof RetryRequestSchema>;

export const ScheduleRequestSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
});
export type ScheduleRequest = z.infer<typeof ScheduleRequestSchema>;

export const CorrectionRequestSchema = z.object({
  note: z.string().trim().min(3).max(2000),
  fields: z.record(z.string().trim().max(500)).optional(),
});
export type CorrectionRequest = z.infer<typeof CorrectionRequestSchema>;

/** Payload the worker sends to HERMES_ENDPOINT when triggering a run. */
export const HermesTriggerPayloadSchema = z.object({
  request_id: z.string(),
  callback_url: z.string().url(),
  schedule: z.object({
    starts_at: z.string().datetime({ offset: true }),
    eastern: z.string(),
    pacific: z.string(),
  }),
  store: z.object({
    code: z.string(),
    name: z.string(),
    autosoft_instance: z.string(),
    stock_prefix: z.string(),
    internal_charges: z.array(InternalChargeSchema),
    charges_total: z.number().int(),
  }),
  vehicle: z.object({
    vin: z.string(),
    model: z.string(),
    stock_number: z.string().nullable(),
  }),
  freight: z.object({
    amount: z.number(),
    evidence: z.record(z.unknown()),
  }),
  corrections: z.array(
    z.object({
      note: z.string(),
      fields: z.record(z.string()).nullable(),
      created_at: z.string(),
    }),
  ),
});
export type HermesTriggerPayload = z.infer<typeof HermesTriggerPayloadSchema>;

/** One authenticated Hermes run that posts a store batch sequentially. */
export const HermesBatchTriggerPayloadSchema = z.object({
  request_id: z.string(),
  callback_url: z.string().url(),
  batch: z.object({
    id: z.string(),
    group_key: z.string(),
    name: z.string(),
    transport_reference: z.string().nullable(),
  }),
  schedule: HermesTriggerPayloadSchema.shape.schedule,
  store: HermesTriggerPayloadSchema.shape.store,
  vehicles: z
    .array(
      z.object({
        request_id: z.string(),
        vin: z.string(),
        model: z.string(),
        stock_number: z.string().nullable(),
        freight: HermesTriggerPayloadSchema.shape.freight,
        corrections: HermesTriggerPayloadSchema.shape.corrections,
      }),
    )
    .min(1)
    .max(200),
});
export type HermesBatchTriggerPayload = z.infer<typeof HermesBatchTriggerPayloadSchema>;
export type HermesDispatchPayload = HermesTriggerPayload | HermesBatchTriggerPayload;
