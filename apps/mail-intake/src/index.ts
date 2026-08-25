import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "./config";
import { logger } from "./logger";
import { createApp } from "./app";
import { createMailProcessor } from "./processor";
import { createMailIntakeQueue, MAIL_INTAKE_QUEUE, type MailIntakeJobData } from "./queues";
import { replyToMessage, sendMessage } from "./agentmail";
import { buildNoVehiclesReply } from "./reply";

async function main(): Promise<void> {
  const config = loadConfig();
  const queue = createMailIntakeQueue(config.REDIS_URL);
  const redis = new Redis(config.REDIS_URL);
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker<MailIntakeJobData>(
    MAIL_INTAKE_QUEUE,
    createMailProcessor({ config, redis, queue }),
    { connection, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, kind: job?.data.kind, err }, "Mail-intake job failed");
    // On the FINAL attempt, never go silent: bounce the sender and alert the
    // operator so a dead email is always visible to a human.
    const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (exhausted && (job.data.kind === "message" || job.data.kind === "finalize")) {
      const messageId = job.data.messageId;
      void replyToMessage(
        config,
        messageId,
        buildNoVehiclesReply(
          "This email could not be processed automatically after several attempts. Nothing was queued — please resend, or contact the operator.",
        ),
      ).catch((replyErr) => logger.error({ replyErr, messageId }, "Failed to send failure bounce"));
      void sendMessage(
        config,
        config.ALERT_EMAIL,
        "Mail intake: email processing failed permanently",
        { text: `Message ${messageId} failed all attempts.\nLast error: ${err?.message ?? "unknown"}` },
      ).catch((alertErr) => logger.error({ alertErr, messageId }, "Failed to send failure alert"));
    }
  });
  worker.on("error", (err) => {
    logger.error({ err }, "Mail-intake worker error");
  });

  const app = createApp(config, queue);
  const server = app.listen(config.MAIL_INTAKE_PORT, () => {
    logger.info(
      { port: config.MAIL_INTAKE_PORT, dryRun: config.DRY_RUN },
      "Mail-intake online: AgentMail webhook + extraction callback + queue worker",
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down mail-intake");
    server.close();
    await worker.close();
    await queue.close();
    redis.disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "Mail-intake failed to start");
  process.exit(1);
});
