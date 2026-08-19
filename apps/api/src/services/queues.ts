import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { FREIGHT_QUEUE, HERMES_QUEUE } from "@lacity/shared";

export interface FreightJobData {
  vehicleId: string;
}

export interface HermesJobData {
  vehicleId: string;
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

/** BullMQ custom job IDs cannot contain colons. */
export function hermesJobId(vehicleId: string, nonce: number): string {
  return `hermes-${vehicleId}-${nonce}`;
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

/** Queue the first freight verification for a vehicle (runs immediately). */
export async function enqueueFreightCheck(
  queues: Queues,
  vehicleId: string,
  opts: { delayMs?: number; nonce: number; attempt: number },
): Promise<void> {
  await queues.freight.add(
    "check",
    { vehicleId },
    {
      jobId: freightJobId(vehicleId, opts.nonce, opts.attempt),
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
): Promise<void> {
  await queues.hermes.add(
    "dispatch",
    { vehicleId },
    {
      jobId: hermesJobId(vehicleId, nonce),
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
}
