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

export function deliveryLaunchKey(
  requestId: string,
  timestamp: string,
  signature: string,
): string {
  return createHash("sha256")
    .update(`${requestId}.${timestamp}.${signature}`)
    .digest("hex")
    .slice(0, 20);
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
  const launchKey = deliveryLaunchKey(requestId, timestamp, signature);

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
    // The launch command only proves a detached delivery process was created.
    // The gateway's actual response is written to the delivery's stdout log.
    // Require the gateway's acceptance so a dead loopback listener fails the
    // trigger now (BullMQ retry / FAILED) instead of surfacing 90 minutes
    // later as a watchdog timeout on a vehicle that was never picked up.
    await verifyOrgoDeliveryAccepted(
      config,
      deliveryLaunchKey(payload.request_id, timestamp, signature),
    );
  }
}

/** Read one dispatch log file on the Windows host through the Orgo bash route. */
async function readDispatchLog(
  config: WorkerConfig,
  launchKey: string,
  stream: "stdout" | "stderr",
): Promise<string> {
  const path = `C:\\data\\lacity-hermes-dispatch\\${launchKey}.${stream}.log`;
  const command = `$ErrorActionPreference='SilentlyContinue'; Get-Content -LiteralPath '${path}' -Raw`;
  let response: Response;
  try {
    response = await fetch(config.HERMES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.HERMES_PROXY_TOKEN
          ? { Authorization: `Bearer ${config.HERMES_PROXY_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new HermesTriggerError(
      `Could not read Hermes delivery log: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new HermesTriggerError(
      `Hermes delivery log read returned HTTP ${response.status}`,
      response.status,
    );
  }
  const body = await response.text();
  try {
    const result = JSON.parse(body) as OrgoCommandResult;
    return result.stdout ?? "";
  } catch {
    return "";
  }
}

const DELIVERY_FAILURE_PATTERNS = [
  /unable to connect/i,
  /actively refused/i,
  /connection refused/i,
  /could not be resolved/i,
  /operation has timed out/i,
  /invoke-restmethod/i,
];

/**
 * Poll the delivery stdout/stderr logs until the gateway acknowledges the
 * webhook ("status":"accepted") or a terminal delivery failure appears.
 */
export async function verifyOrgoDeliveryAccepted(
  config: WorkerConfig,
  launchKey: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const deadline = Date.now() + config.HERMES_DELIVERY_VERIFY_MS;
  let lastStdout = "";
  let lastStderr = "";
  for (;;) {
    lastStdout = await readDispatchLog(config, launchKey, "stdout");
    if (/"status"\s*:\s*"accepted"/i.test(lastStdout)) return;
    lastStderr = await readDispatchLog(config, launchKey, "stderr");
    const failure = DELIVERY_FAILURE_PATTERNS.find((pattern) => pattern.test(lastStderr));
    if (failure) {
      throw new HermesTriggerError(
        `Hermes gateway did not accept the delivery (${failure.source}): ${lastStderr.replace(/\s+/g, " ").slice(0, 400)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new HermesTriggerError(
        `Hermes gateway did not acknowledge delivery ${launchKey} within ${config.HERMES_DELIVERY_VERIFY_MS}ms` +
          (lastStdout ? `; last stdout: ${lastStdout.slice(0, 200)}` : "; delivery log is empty"),
      );
    }
    await sleep(config.HERMES_DELIVERY_POLL_MS);
  }
}
