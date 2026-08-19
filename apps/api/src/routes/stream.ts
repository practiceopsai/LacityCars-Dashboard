import { Router, type Response } from "express";
import { Redis } from "ioredis";
import { VEHICLE_UPDATES_CHANNEL } from "@lacity/shared";
import { logger } from "../logger";

const HEARTBEAT_MS = 15_000;

export interface StreamHandle {
  router: Router;
  close: () => Promise<void>;
}

/**
 * GET /api/vehicles/stream — Server-Sent Events.
 * One Redis subscriber per API process fans messages out to every connected
 * dashboard. Heartbeat comments keep proxies from closing idle connections.
 */
export function createStream(redisUrl: string): StreamHandle {
  const subscriber = new Redis(redisUrl);
  const clients = new Set<Response>();

  subscriber.subscribe(VEHICLE_UPDATES_CHANNEL).catch((err) => {
    logger.error({ err }, "Failed to subscribe to vehicle updates channel");
  });
  subscriber.on("message", (_channel, message) => {
    for (const res of clients) {
      res.write(`event: vehicle-updated\ndata: ${message}\n\n`);
    }
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const router = Router();
  router.get("/", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: connected\ndata: {"ok":true}\n\n`);
    clients.add(res);
    req.on("close", () => {
      clients.delete(res);
    });
  });

  return {
    router,
    close: async () => {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
      subscriber.disconnect();
    },
  };
}
