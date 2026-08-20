import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { getPrisma } from "@lacity/database";
import { FREIGHT_QUEUE, HERMES_QUEUE } from "@lacity/shared";
import { loadConfig } from "./config";
import { logger } from "./logger";
import { createFreightProcessor } from "./processors/freightCheck";
import { createBatchFreightProcessor } from "./processors/batchFreightCheck";
import { createHermesProcessor } from "./processors/hermesDispatch";
import { createBatchDispatchProcessor } from "./processors/batchDispatch";
import { createWorkerQueues, type FreightJobData, type HermesJobData } from "./queues";
import { recoverStaleBatches, recoverStaleProcessing } from "./staleProcessing";

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma();
  const publisher = new Redis(config.REDIS_URL);
  const queues = createWorkerQueues(config.REDIS_URL);
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const vehicleFreight = createFreightProcessor({ prisma, config, publisher, queues });
  const batchFreight = createBatchFreightProcessor({ prisma, config, publisher, queues });
  const freightWorker = new Worker<FreightJobData>(
    FREIGHT_QUEUE,
    (job) => (job.data.batchId ? batchFreight(job) : vehicleFreight(job)),
    { connection, concurrency: 5 },
  );
  const vehicleDispatch = createHermesProcessor({ prisma, config, publisher });
  const batchDispatch = createBatchDispatchProcessor({ prisma, config, publisher });
  const hermesWorker = new Worker<HermesJobData>(
    HERMES_QUEUE,
    (job, token) => (job.data.batchId ? batchDispatch(job, token) : vehicleDispatch(job, token)),
    // One desktop can safely operate only one AutoSoft session at a time.
    { connection, concurrency: 1 },
  );

  for (const [name, worker] of [
    ["freight", freightWorker],
    ["hermes", hermesWorker],
  ] as const) {
    worker.on("failed", (job, err) => {
      logger.error({ queue: name, jobId: job?.id, err }, "Job failed");
    });
    worker.on("error", (err) => {
      logger.error({ queue: name, err }, "Worker error");
    });
  }

  logger.info("Worker online: freight-check + hermes-dispatch");

  const runWatchdog = (): void => {
    void (async () => {
      await recoverStaleBatches({ prisma, publisher, timeoutMs: config.HERMES_PROCESSING_TIMEOUT_MS });
      await recoverStaleProcessing({ prisma, publisher, timeoutMs: config.HERMES_PROCESSING_TIMEOUT_MS });
    })().catch((err) => logger.error({ err }, "Hermes processing watchdog failed"));
  };
  runWatchdog();
  const watchdog = setInterval(runWatchdog, config.HERMES_WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down worker");
    clearInterval(watchdog);
    await freightWorker.close();
    await hermesWorker.close();
    await queues.close();
    connection.disconnect();
    publisher.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "Worker failed to start");
  process.exit(1);
});
