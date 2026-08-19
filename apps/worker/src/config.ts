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
    HERMES_API_TOKEN: z.string().min(8, "HERMES_API_TOKEN is required"),
    PUBLIC_API_URL: z.string().url("PUBLIC_API_URL must be a URL"),
    DISPATCH_WORKBOOK_URL: z.string().url().optional().or(z.literal("")),
    DISPATCH_WORKBOOK_PATH: z.string().optional().or(z.literal("")),
    FREIGHT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(DEFAULT_FREIGHT_MAX_ATTEMPTS),
    FREIGHT_BACKOFF_BASE_MS: z.coerce.number().int().min(1000).default(DEFAULT_FREIGHT_BACKOFF_BASE_MS),
    FREIGHT_BACKOFF_MAX_MS: z.coerce.number().int().min(1000).default(DEFAULT_FREIGHT_BACKOFF_MAX_MS),
    HERMES_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
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
