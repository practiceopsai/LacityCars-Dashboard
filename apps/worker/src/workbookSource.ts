import { readFile } from "node:fs/promises";
import { parseDispatchWorkbook, type DispatchRow } from "@lacity/freight";
import type { WorkerConfig } from "./config";

export interface WorkbookSnapshot {
  rows: DispatchRow[];
  /** Where the workbook came from, recorded in freight evidence. */
  source: string;
  fetchedAt: string;
}

export class WorkbookSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookSourceError";
  }
}

/**
 * Load a FRESH copy of the dispatch workbook for every check — freight must
 * always be computed against current data, never a stale cache.
 */
export async function loadDispatchWorkbook(config: WorkerConfig): Promise<WorkbookSnapshot> {
  let buffer: Buffer;
  let source: string;

  if (config.DISPATCH_WORKBOOK_URL) {
    source = config.DISPATCH_WORKBOOK_URL;
    let response: Response;
    try {
      response = await fetch(config.DISPATCH_WORKBOOK_URL, {
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new WorkbookSourceError(
        `Could not fetch dispatch workbook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      throw new WorkbookSourceError(
        `Dispatch workbook fetch returned HTTP ${response.status}`,
      );
    }
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    source = config.DISPATCH_WORKBOOK_PATH!;
    try {
      buffer = await readFile(source);
    } catch (err) {
      throw new WorkbookSourceError(
        `Could not read dispatch workbook at ${source}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const rows = await parseDispatchWorkbook(buffer);
  return { rows, source, fetchedAt: new Date().toISOString() };
}

let batchSnapshot: { expiresAt: number; promise: Promise<WorkbookSnapshot> } | null = null;

/**
 * Store batches launched together share one newly-fetched workbook snapshot.
 * The short window only coalesces the same transport operation; later retry
 * ticks fetch current dispatch data again.
 */
export function loadDispatchWorkbookForBatch(
  config: WorkerConfig,
  maxAgeMs = 30_000,
): Promise<WorkbookSnapshot> {
  if (batchSnapshot && batchSnapshot.expiresAt > Date.now()) return batchSnapshot.promise;
  const promise = loadDispatchWorkbook(config).catch((error) => {
    batchSnapshot = null;
    throw error;
  });
  batchSnapshot = { expiresAt: Date.now() + maxAgeMs, promise };
  return promise;
}
