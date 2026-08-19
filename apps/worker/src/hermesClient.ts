import type { HermesTriggerPayload } from "@lacity/shared";
import type { WorkerConfig } from "./config";

export class HermesTriggerError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "HermesTriggerError";
  }
}

/** POST the trigger payload to the Hermes agent, authenticated with the API token. */
export async function triggerHermes(
  config: WorkerConfig,
  payload: HermesTriggerPayload,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(config.HERMES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.HERMES_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.HERMES_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HermesTriggerError(
      `Could not reach Hermes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HermesTriggerError(
      `Hermes trigger returned HTTP ${response.status}: ${body.slice(0, 500)}`,
      response.status,
    );
  }
}
