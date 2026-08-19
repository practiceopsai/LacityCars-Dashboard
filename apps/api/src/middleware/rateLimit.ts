import type { NextFunction, Request, Response } from "express";
import type { Redis } from "ioredis";
import { logger } from "../logger";
import { HttpError } from "./error";

export interface RateLimitOptions {
  /** Bucket name so different route groups have independent budgets. */
  bucket: string;
  /** Max requests per window per client IP. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * Redis fixed-window rate limiter. Fails OPEN (with a log line) if Redis is
 * unavailable — availability of the operator dashboard wins over strictness;
 * webhook auth still applies regardless.
 */
export function rateLimit(redis: Redis, options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip ?? "unknown";
    const windowStart = Math.floor(Date.now() / (options.windowSeconds * 1000));
    const key = `rl:${options.bucket}:${ip}:${windowStart}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, options.windowSeconds + 1);
      }
      res.setHeader("X-RateLimit-Limit", String(options.limit));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, options.limit - count)));
      if (count > options.limit) {
        next(new HttpError(429, "RATE_LIMITED", "Too many requests; slow down"));
        return;
      }
      next();
    } catch (err) {
      logger.warn({ err, bucket: options.bucket }, "Rate limiter unavailable; failing open");
      next();
    }
  };
}
