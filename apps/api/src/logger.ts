import pino from "pino";

/**
 * Structured logger with secret redaction. Anything resembling credentials,
 * tokens, cookies, or signatures is masked before it can reach log sinks.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-hermes-signature']",
      "*.password",
      "*.secret",
      "*.token",
      "*.apiToken",
      "*.sessionSecret",
      "password",
      "secret",
      "token",
    ],
    censor: "[REDACTED]",
  },
});

export type Logger = typeof logger;
