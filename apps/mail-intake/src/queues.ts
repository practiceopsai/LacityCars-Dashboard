import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { ExtractedRow } from "./extract/types";

export const MAIL_INTAKE_QUEUE = "mail-intake";

/**
 * Deterministic BullMQ job id for idempotent enqueues. Email message ids are
 * arbitrary strings and BullMQ forbids ':' in custom ids, so hash them.
 */
export function jobKey(prefix: string, id: string): string {
  return `${prefix}-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/** Job that processes one received email end to end (or up to PDF hand-off). */
export interface MessageJobData {
  kind: "message";
  messageId: string;
}

/** Job that finishes an email once the Hermes PDF extraction has called back. */
export interface FinalizeJobData {
  kind: "finalize";
  messageId: string;
  pdfRows: ExtractedRow[];
  pdfWarnings: string[];
}

/** Delayed job that bounces an email whose PDF extraction never called back. */
export interface ExtractionTimeoutJobData {
  kind: "extraction-timeout";
  messageId: string;
}

export type MailIntakeJobData = MessageJobData | FinalizeJobData | ExtractionTimeoutJobData;

export function createMailIntakeQueue(redisUrl: string): Queue<MailIntakeJobData> {
  return new Queue<MailIntakeJobData>(MAIL_INTAKE_QUEUE, {
    connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
}

/** Pending PDF-extraction context, keyed by message id, stored in Redis. */
export interface PendingExtraction {
  messageId: string;
  sender: string;
  subject: string;
  fallbackStoreCode: string | null;
  spreadsheetRows: ExtractedRow[];
  warnings: string[];
  startedAt: string;
}

const PENDING_PREFIX = "mail-intake:pending:";
const PENDING_TTL_SECONDS = 24 * 3600;

export async function savePending(redis: Redis, pending: PendingExtraction): Promise<void> {
  await redis.set(
    `${PENDING_PREFIX}${pending.messageId}`,
    JSON.stringify(pending),
    "EX",
    PENDING_TTL_SECONDS,
  );
}

export async function takePending(
  redis: Redis,
  messageId: string,
): Promise<PendingExtraction | null> {
  const key = `${PENDING_PREFIX}${messageId}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  return JSON.parse(raw) as PendingExtraction;
}
