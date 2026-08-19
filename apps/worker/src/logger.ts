import pino from "pino";

/** Structured worker logger with secret redaction. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["*.token", "*.apiToken", "*.secret", "*.authorization", "headers.authorization"],
    censor: "[REDACTED]",
  },
});
