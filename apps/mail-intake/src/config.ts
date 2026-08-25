import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** HTTP port for the webhook + callback listener. Railway injects PORT. */
    MAIL_INTAKE_PORT: z.coerce.number().int().min(1).default(3000),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),

    /** AgentMail credentials for the staff-facing inbox. */
    AGENTMAIL_API_KEY: z.string().min(8, "AGENTMAIL_API_KEY is required"),
    AGENTMAIL_INBOX_ID: z.string().min(3, "AGENTMAIL_INBOX_ID is required"),
    /** Svix endpoint secret from the AgentMail webhook (whsec_...). */
    AGENTMAIL_WEBHOOK_SECRET: z.string().min(8, "AGENTMAIL_WEBHOOK_SECRET is required"),
    AGENTMAIL_BASE_URL: z.string().url().default("https://api.agentmail.to/v0"),

    /** Comma-separated email addresses allowed to submit vehicles. */
    STAFF_ALLOWLIST: z.string().min(3, "STAFF_ALLOWLIST is required"),
    /** Operator address for security/failure alerts. */
    ALERT_EMAIL: z.string().email("ALERT_EMAIL must be an email address"),

    /** Dashboard API the service enqueues into. */
    API_BASE_URL: z.string().url("API_BASE_URL must be a URL"),
    OPERATOR_PASSWORD: z.string().min(8, "OPERATOR_PASSWORD is required"),

    /** HMAC secret for the Hermes extraction callback (>=32 chars, like HERMES_TRIGGER_SECRET). */
    EXTRACTION_CALLBACK_SECRET: z
      .string()
      .min(32, "EXTRACTION_CALLBACK_SECRET must be at least 32 characters"),
    /** Public base URL of THIS service, for the callback address given to the gateway. */
    PUBLIC_BASE_URL: z.string().url("PUBLIC_BASE_URL must be a URL"),

    /** Hermes/Orgo transport for PDF extraction — same values the worker uses. */
    HERMES_ENDPOINT: z.string().url("HERMES_ENDPOINT must be a URL"),
    HERMES_LOCAL_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
    HERMES_EXTRACTION_SECRET: z
      .string()
      .min(32, "HERMES_EXTRACTION_SECRET must be at least 32 characters"),
    HERMES_PROXY_TOKEN: z.string().min(8).optional().or(z.literal("")),
    /** How long a PDF extraction may stay pending before it is bounced. */
    EXTRACTION_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(1_200_000),

    /** Shadow mode: parse + reply, but never call the intake API. */
    DRY_RUN: z
      .string()
      .default("false")
      .transform((value) => value.trim().toLowerCase() === "true"),

    /** Svix timestamp tolerance. */
    WEBHOOK_TOLERANCE_MS: z.coerce.number().int().min(30_000).default(300_000),
    /** Max attachment size accepted for parsing. */
    MAX_ATTACHMENT_BYTES: z.coerce.number().int().min(1024).default(15_000_000),
  })
  .superRefine((value, ctx) => {
    const entries = value.STAFF_ALLOWLIST.split(",").map((entry) => entry.trim());
    if (entries.some((entry) => entry.length > 0 && !entry.includes("@"))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "STAFF_ALLOWLIST entries must be email addresses",
        path: ["STAFF_ALLOWLIST"],
      });
    }
  });

export type MailIntakeConfig = z.infer<typeof EnvSchema>;

let cached: MailIntakeConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MailIntakeConfig {
  if (cached) return cached;
  const withPort = { ...env, MAIL_INTAKE_PORT: env.MAIL_INTAKE_PORT ?? env.PORT };
  const parsed = EnvSchema.safeParse(withPort);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid mail-intake environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook. */
export function resetConfigCache(): void {
  cached = undefined;
}
