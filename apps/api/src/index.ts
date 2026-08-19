import { Redis } from "ioredis";
import { getPrisma } from "@lacity/database";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { logger } from "./logger";
import { createStream } from "./routes/stream";
import { createQueues } from "./services/queues";

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma();
  const redis = new Redis(config.REDIS_URL);
  const publisher = new Redis(config.REDIS_URL);
  const queues = createQueues(config.REDIS_URL);
  const stream = createStream(config.REDIS_URL);

  const app = buildApp({ config, prisma, redis, publisher, queues, stream });
  const server = app.listen(config.API_PORT, () => {
    logger.info({ port: config.API_PORT }, "API listening");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down API");
    server.close();
    await stream.close();
    await queues.close();
    redis.disconnect();
    publisher.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "API failed to start");
  process.exit(1);
});
