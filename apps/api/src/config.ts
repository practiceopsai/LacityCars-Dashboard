import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  OPERATOR_PASSWORD: z.string().min(8, "OPERATOR_PASSWORD must be at least 8 characters"),
  HERMES_WEBHOOK_SECRET: z.string().min(16, "HERMES_WEBHOOK_SECRET must be at least 16 characters"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
});

export type ApiConfig = z.infer<typeof EnvSchema>;

let cached: ApiConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid API environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function isProduction(config: ApiConfig): boolean {
  return config.NODE_ENV === "production";
}
