import pino from "pino";

/** Structured mail-intake logger with secret redaction. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["*.token", "*.apiKey", "*.secret", "*.authorization", "headers.authorization"],
    censor: "[REDACTED]",
  },
});
