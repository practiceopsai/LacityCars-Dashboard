import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { FREIGHT_QUEUE, HERMES_QUEUE } from "@lacity/shared";

export interface FreightJobData {
  vehicleId: string;
  nonce: number;
  attempt: number;
}

export interface HermesJobData {
  vehicleId: string;
  nonce: number;
}

export interface WorkerQueues {
  freight: Queue<FreightJobData>;
  hermes: Queue<HermesJobData>;
  close: () => Promise<void>;
}

/** BullMQ custom job IDs cannot contain colons. */
export function freightJobId(vehicleId: string, nonce: number, attempt: number): string {
  return `freight-${vehicleId}-${nonce}-${attempt}`;
}

/** BullMQ custom job IDs cannot contain colons. */
export function hermesJobId(vehicleId: string, nonce: number): string {
  return `hermes-${vehicleId}-${nonce}`;
}

export function createWorkerQueues(redisUrl: string): WorkerQueues {
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

export async function enqueueFreightCheck(
  queues: WorkerQueues,
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

export async function enqueueHermesDispatch(
  queues: WorkerQueues,
  vehicleId: string,
  nonce: number,
  scheduledStartAt?: Date | null,
): Promise<void> {
  const delay = scheduledStartAt ? Math.max(0, scheduledStartAt.getTime() - Date.now()) : 0;
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
