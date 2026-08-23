import { createHash, createHmac } from "node:crypto";
import type { HermesDispatchPayload } from "@lacity/shared";
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

interface OrgoCommandResult {
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function buildOrgoForwardCommand(
  localUrl: string,
  body: string,
  timestamp: string,
  signature: string,
  requestId: string,
): string {
  // Every dynamic string is base64-encoded before it enters PowerShell. This
  // keeps vehicle data and URLs out of command syntax and prevents injection.
  //
  // Hermes keeps the webhook request open until the entire browser run has
  // finished. Orgo commands, however, have a much shorter hard execution
  // limit. Launch the signed localhost POST in a detached hidden process and
  // return only after Windows confirms that process was created. Dashboard
  // PROCESSING state remains the durable run lease and the signed terminal
  // callback is the source of truth for completion.
  const deliveryScript = [
    "$ErrorActionPreference='Stop'",
    `$url=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toBase64(localUrl)}'))`,
    `$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toBase64(body)}'))`,
    `$requestId=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toBase64(requestId)}'))`,
    `$headers=@{'X-Webhook-Timestamp'='${timestamp}';'X-Webhook-Signature-V2'='${signature}';'X-Request-ID'=$requestId}`,
    "$response=Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 21600",
    "$response | ConvertTo-Json -Compress",
  ].join("; ");
  // Windows PowerShell's -EncodedCommand consumes UTF-16LE.
  const encodedDelivery = Buffer.from(deliveryScript, "utf16le").toString("base64");
  const launchKey = createHash("sha256")
    .update(`${requestId}.${timestamp}.${signature}`)
    .digest("hex")
    .slice(0, 20);

  return [
    "$ErrorActionPreference='Stop'",
    "$dispatchDir='C:\\data\\lacity-hermes-dispatch'",
    "[IO.Directory]::CreateDirectory($dispatchDir)|Out-Null",
    `$stdout=Join-Path $dispatchDir '${launchKey}.stdout.log'`,
    `$stderr=Join-Path $dispatchDir '${launchKey}.stderr.log'`,
    `$process=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${encodedDelivery}') -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru`,
    `[pscustomobject]@{accepted=$true;process_id=$process.Id;request_key='${launchKey}'}|ConvertTo-Json -Compress`,
  ].join("; ");
}

/**
 * POST a vehicle-ready event to Hermes's native webhook gateway.
 *
 * Hermes HMAC v2 signs `<unix timestamp>.<raw body>`, which binds the
 * signature to a short replay window. X-Request-ID is also Hermes's
 * idempotency key. HERMES_PROXY_TOKEN is optional transport auth (used by
 * Orgo's authenticated computer API); it is not a model-provider API key.
 */
export async function triggerHermes(
  config: WorkerConfig,
  payload: HermesDispatchPayload,
): Promise<void> {
  const eventType = "vehicles" in payload ? "vehicle.batch_ready" : "vehicle.ready";
  const body = JSON.stringify({ event_type: eventType, ...payload });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", config.HERMES_TRIGGER_SECRET)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");

  let response: Response;
  const throughOrgo = Boolean(config.HERMES_PROXY_TOKEN && config.HERMES_LOCAL_WEBHOOK_URL);
  const requestBody = throughOrgo
    ? JSON.stringify({
        command: buildOrgoForwardCommand(
          config.HERMES_LOCAL_WEBHOOK_URL!,
          body,
          timestamp,
          signature,
          payload.request_id,
        ),
      })
    : body;
  try {
    response = await fetch(config.HERMES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(!throughOrgo
          ? {
              "X-Webhook-Timestamp": timestamp,
              "X-Webhook-Signature-V2": signature,
              "X-Request-ID": payload.request_id,
            }
          : {}),
        ...(config.HERMES_PROXY_TOKEN
          ? { Authorization: `Bearer ${config.HERMES_PROXY_TOKEN}` }
          : {}),
      },
      body: requestBody,
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
  if (throughOrgo) {
    const responseBody = await response.text();
    let result: OrgoCommandResult;
    try {
      result = JSON.parse(responseBody) as OrgoCommandResult;
    } catch {
      throw new HermesTriggerError("Orgo trigger transport returned invalid JSON");
    }
    if (result.exit_code !== 0) {
      throw new HermesTriggerError(
        `Orgo could not forward the Hermes webhook: ${(result.stderr || result.stdout || "unknown error").slice(0, 500)}`,
      );
    }
  }
}
