import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import type { PrismaClient } from "@lacity/database";
import type { Redis } from "ioredis";
import type { ApiConfig } from "./config";
import { requireCsrfHeader, requireSession } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { rateLimit } from "./middleware/rateLimit";
import { requestId } from "./middleware/requestId";
import { authRouter } from "./routes/auth";
import { healthRouter } from "./routes/health";
import { storesRouter } from "./routes/stores";
import type { StreamHandle } from "./routes/stream";
import { vehiclesRouter } from "./routes/vehicles";
import { webhooksRouter } from "./routes/webhooks";
import type { Queues } from "./services/queues";

export interface AppDeps {
  config: ApiConfig;
  prisma: PrismaClient;
  /** General-purpose Redis connection (rate limiting, readiness). */
  redis: Redis;
  /** Dedicated publisher connection for pub/sub. */
  publisher: Redis;
  queues: Queues;
  stream: StreamHandle;
}

export function buildApp(deps: AppDeps): Express {
  const { config, prisma, redis, publisher, queues, stream } = deps;
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(requestId);
  app.use(helmet());
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));

  // Unauthenticated liveness/readiness for Railway.
  app.use(healthRouter(prisma, redis));

  // Hermes webhook needs the raw body for HMAC verification — mounted before
  // the JSON parser, with its own authentication and rate limit.
  app.use(
    "/api/webhooks",
    rateLimit(redis, { bucket: "webhook", limit: 120, windowSeconds: 60 }),
    express.raw({ type: () => true, limit: "1mb" }),
    webhooksRouter(prisma, config, publisher),
  );

  app.use(express.json({ limit: "1mb" }));

  app.use(
    "/api/auth",
    rateLimit(redis, { bucket: "auth", limit: 10, windowSeconds: 60 }),
    authRouter(config),
  );

  const session = requireSession(config);
  const mutationLimiter = rateLimit(redis, { bucket: "mutations", limit: 60, windowSeconds: 60 });

  // SSE stream — mounted before /api/vehicles so "/stream" never hits "/:id".
  app.use("/api/vehicles/stream", session, stream.router);
  app.use(
    "/api/vehicles",
    session,
    vehiclesRouter(prisma, queues, publisher, { csrf: requireCsrfHeader, limiter: mutationLimiter }),
  );

  const storeRoutes = storesRouter(prisma);
  app.use(
    "/api/stores",
    session,
    (req, res, next) => {
      if (req.method === "GET") {
        next();
        return;
      }
      mutationLimiter(req, res, (err?: unknown) => {
        if (err) {
          next(err);
          return;
        }
        requireCsrfHeader(req, res, next);
      });
    },
    storeRoutes,
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
