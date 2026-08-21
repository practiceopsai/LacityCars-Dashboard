import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { FREIGHT_QUEUE, HERMES_QUEUE } from "@lacity/shared";

const AUTO_BATCH_SETTLE_MS = 30_000;

export interface FreightJobData {
  vehicleId?: string;
  batchId?: string;
  nonce: number;
  attempt: number;
}

export interface HermesJobData {
  vehicleId?: string;
  batchId?: string;
  nonce: number;
}

export interface Queues {
  freight: Queue<FreightJobData>;
  hermes: Queue<HermesJobData>;
  close: () => Promise<void>;
}

/** BullMQ custom job IDs cannot contain colons. */
export function freightJobId(vehicleId: string, nonce: number, attempt: number): string {
  return `freight-${vehicleId}-${nonce}-${attempt}`;
}

export function batchFreightJobId(batchId: string, attempt: number): string {
  return `freight-batch-${batchId}-${attempt}`;
}

/** BullMQ custom job IDs cannot contain colons. */
export function hermesJobId(vehicleId: string, nonce: number): string {
  return `hermes-${vehicleId}-${nonce}`;
}

export function batchHermesJobId(batchId: string, nonce: number): string {
  return `hermes-batch-${batchId}-${nonce}`;
}

export function createQueues(redisUrl: string): Queues {
  // BullMQ requires maxRetriesPerRequest: null on its connections.
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const freight = new Queue<FreightJobData>(FREIGHT_QUEUE, { connection });
  const hermes = new Queue<HermesJobData>(HERMES_QUEUE, { connection });
  return {
    freight,
    hermes,
    close: async () => {
      await freight.close();
      await hermes.close();
      connection.disconnect();
    },
  };
}

/** Queue one store batch as a single sequential Hermes desktop run. */
export async function enqueueBatchHermesDispatch(
  queues: Queues,
  batchId: string,
  nonce: number,
  scheduledStartAt: Date,
): Promise<void> {
  await queues.hermes.add(
    "dispatch-batch",
    { batchId, nonce },
    {
      jobId: batchHermesJobId(batchId, nonce),
      delay: Math.max(0, scheduledStartAt.getTime() - Date.now()),
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
}

/** Queue the first freight verification for a vehicle (runs immediately). */
export async function enqueueFreightCheck(
  queues: Queues,
  vehicleId: string,
  opts: { delayMs?: number; nonce: number; attempt: number },
): Promise<void> {
  await queues.freight.add(
    "check",
    { vehicleId, nonce: opts.nonce, attempt: opts.attempt },
    {
      jobId: freightJobId(vehicleId, opts.nonce, opts.attempt),
      delay: opts.delayMs ?? 0,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
}

export async function enqueueBatchFreightCheck(
  queues: Queues,
  batchId: string,
  opts: { delayMs?: number; attempt: number },
): Promise<void> {
  await queues.freight.add(
    "check-batch",
    { batchId, nonce: 0, attempt: opts.attempt },
    {
      jobId: batchFreightJobId(batchId, opts.attempt),
      delay: opts.delayMs ?? 0,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
}

/** Queue a Hermes dispatch. jobId includes the nonce so a vehicle is never queued twice per cycle. */
export async function enqueueHermesDispatch(
  queues: Queues,
  vehicleId: string,
  nonce: number,
  scheduledStartAt?: Date | null,
): Promise<void> {
  const delay = Math.max(
    AUTO_BATCH_SETTLE_MS,
    scheduledStartAt ? scheduledStartAt.getTime() - Date.now() : 0,
  );
  await queues.hermes.add(
    "dispatch",
    { vehicleId, nonce },
    {
      jobId: hermesJobId(vehicleId, nonce),
      delay,
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
}
