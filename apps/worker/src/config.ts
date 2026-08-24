import {
  DEFAULT_FREIGHT_BACKOFF_BASE_MS,
  DEFAULT_FREIGHT_BACKOFF_MAX_MS,
  DEFAULT_FREIGHT_MAX_ATTEMPTS,
} from "@lacity/shared";
import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    HERMES_ENDPOINT: z.string().url("HERMES_ENDPOINT must be a URL"),
    HERMES_LOCAL_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
    HERMES_TRIGGER_SECRET: z.string().min(32, "HERMES_TRIGGER_SECRET must be at least 32 characters"),
    HERMES_PROXY_TOKEN: z.string().min(8).optional().or(z.literal("")),
    PUBLIC_API_URL: z.string().url("PUBLIC_API_URL must be a URL"),
    DISPATCH_WORKBOOK_URL: z.string().url().optional().or(z.literal("")),
    DISPATCH_WORKBOOK_PATH: z.string().optional().or(z.literal("")),
    FREIGHT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(DEFAULT_FREIGHT_MAX_ATTEMPTS),
    FREIGHT_BACKOFF_BASE_MS: z.coerce.number().int().min(1000).default(DEFAULT_FREIGHT_BACKOFF_BASE_MS),
    FREIGHT_BACKOFF_MAX_MS: z.coerce.number().int().min(1000).default(DEFAULT_FREIGHT_BACKOFF_MAX_MS),
    FREIGHT_SWEEP_CRON: z.string().min(1).default("0 8,20 * * *"),
    FREIGHT_SWEEP_TIME_ZONE: z.string().min(1).default("America/New_York"),
    // The Orgo transport waits for the Windows gateway's HTTP response. On
    // the 1-vCPU desktop, Hermes may need over 30 seconds to allocate a fresh
    // webhook session even though it has already accepted the delivery.
    // Keep this above the forwarding command's timeout so a valid acceptance
    // cannot be mistaken for a failed trigger and release the desktop lock.
    HERMES_TIMEOUT_MS: z.coerce.number().int().min(180_000).default(240_000),
    // After launching the detached delivery process, the worker polls the
    // delivery's stdout log until the gateway's own {"status":"accepted"}
    // response appears. A dead loopback gateway therefore fails the trigger
    // within this window instead of ripening into a 90-minute watchdog FAILED.
    HERMES_DELIVERY_VERIFY_MS: z.coerce.number().int().min(10_000).default(90_000),
    HERMES_DELIVERY_POLL_MS: z.coerce.number().int().min(1_000).default(5_000),
    HERMES_BUSY_DELAY_MS: z.coerce.number().int().min(5_000).default(30_000),
    HERMES_PROCESSING_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(5_400_000),
    HERMES_WATCHDOG_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  })
  .superRefine((value, ctx) => {
    if (!value.DISPATCH_WORKBOOK_URL && !value.DISPATCH_WORKBOOK_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide DISPATCH_WORKBOOK_URL or DISPATCH_WORKBOOK_PATH",
        path: ["DISPATCH_WORKBOOK_URL"],
      });
    }
  });

export type WorkerConfig = z.infer<typeof EnvSchema>;

let cached: WorkerConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid worker environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
