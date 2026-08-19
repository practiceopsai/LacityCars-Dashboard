import { Router } from "express";
import type { PrismaClient } from "@lacity/database";
import type { Redis } from "ioredis";

/** Liveness + readiness for Railway health checks. */
export function healthRouter(prisma: PrismaClient, redis: Redis): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "api" });
  });

  router.get("/ready", async (_req, res) => {
    const checks: Record<string, "ok" | "error"> = { database: "error", redis: "error" };
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch {
      /* reported below */
    }
    try {
      const pong = await redis.ping();
      if (pong === "PONG") checks.redis = "ok";
    } catch {
      /* reported below */
    }
    const ready = Object.values(checks).every((c) => c === "ok");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
  });

  return router;
}
