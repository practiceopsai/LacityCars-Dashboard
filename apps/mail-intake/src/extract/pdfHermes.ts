import { createHmac, randomUUID } from "node:crypto";
import type { MailIntakeConfig } from "../config";
import { logger } from "../logger";

/**
 * PDF extraction rides the existing Hermes/Orgo transport (operator's choice —
 * no separate model API key). The PDF is written onto the Windows host in
 * base64 chunks through the Orgo bash route, then the gateway's `email-intake`
 * route is triggered with the file paths; the agent posts extracted rows back
 * to this service's /callbacks/extraction endpoint via the synced
 * integrations/hermes/extraction_callback.py helper.
 */

const VM_BASE_DIR = "C:\\\\data\\\\mail-intake";
const B64_CHUNK = 30_000;

export class PdfTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfTransportError";
  }
}

interface OrgoCommandResult {
  output?: string;
  error?: string;
}

async function orgoBash(config: MailIntakeConfig, command: string): Promise<string> {
  const response = await fetch(config.HERMES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.HERMES_PROXY_TOKEN
        ? { Authorization: `Bearer ${config.HERMES_PROXY_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new PdfTransportError(`Orgo bash failed: ${response.status} ${body.slice(0, 200)}`);
  }
  try {
    const parsed = JSON.parse(body) as OrgoCommandResult;
    return parsed.output ?? "";
  } catch {
    return body;
  }
}

/** Sanitize a filename for a Windows path segment. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "attachment.pdf";
}

/** Upload one PDF to the VM; returns its remote path. */
export async function uploadPdfToVm(
  config: MailIntakeConfig,
  messageId: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const dirId = messageId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  const dir = `${VM_BASE_DIR}\\\\${dirId}`;
  const remotePath = `${dir}\\\\${safeName(filename)}`;
  const b64Path = `${remotePath}.b64`;

  await orgoBash(
    config,
    `New-Item -ItemType Directory -Force '${dir}' | Out-Null; Remove-Item '${b64Path}' -Force -ErrorAction SilentlyContinue`,
  );
  const encoded = buffer.toString("base64");
  for (let i = 0; i < encoded.length; i += B64_CHUNK) {
    const chunk = encoded.slice(i, i + B64_CHUNK);
    await orgoBash(config, `Add-Content -Path '${b64Path}' -Value '${chunk}'`);
  }
  const sizeOutput = await orgoBash(
    config,
    `[IO.File]::WriteAllBytes('${remotePath}',[Convert]::FromBase64String((Get-Content '${b64Path}' -Raw))); Remove-Item '${b64Path}' -Force; (Get-Item '${remotePath}').Length`,
  );
  const remoteSize = Number(String(sizeOutput).trim().split(/\s+/).pop());
  if (remoteSize !== buffer.length) {
    throw new PdfTransportError(
      `Uploaded size mismatch for ${filename}: local ${buffer.length}, remote ${remoteSize}`,
    );
  }
  return remotePath;
}

export interface ExtractionTriggerInput {
  messageId: string;
  subject: string;
  bodyExcerpt: string;
  pdfPaths: string[];
}

/**
 * Trigger the gateway's email-intake route. The webhook body is signed the
 * same way the worker signs vehicle-stocking triggers (HMAC v2 over
 * `<timestamp>.<body>`), and delivered via a detached PowerShell POST whose
 * stdout is verified for the gateway's `"status":"accepted"` acknowledgement.
 */
export async function triggerPdfExtraction(
  config: MailIntakeConfig,
  input: ExtractionTriggerInput,
): Promise<void> {
  const gatewayUrl = config.HERMES_LOCAL_WEBHOOK_URL || "http://127.0.0.1:8644/webhook";
  const payload = JSON.stringify({
    event: "document.extract",
    request_id: input.messageId,
    subject: input.subject.slice(0, 300),
    body_excerpt: input.bodyExcerpt.slice(0, 1500),
    files: input.pdfPaths,
    callback_url: `${config.PUBLIC_BASE_URL}/callbacks/extraction`,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", config.HERMES_EXTRACTION_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  // Same pattern as the worker's buildOrgoForwardCommand: every dynamic
  // string enters PowerShell base64-encoded, and the detached POST runs via
  // -EncodedCommand (UTF-16LE) so no quoting survives to be broken.
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const launchKey = randomUUID().slice(0, 12);
  const deliveryScript = [
    "$ErrorActionPreference='Stop'",
    `$url=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(gatewayUrl)}'))`,
    `$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(payload)}'))`,
    `$headers=@{'X-Webhook-Timestamp'='${timestamp}';'X-Webhook-Signature-V2'='${signature}'}`,
    "$response=Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 21600",
    "$response | ConvertTo-Json -Compress",
  ].join("; ");
  const encodedDelivery = Buffer.from(deliveryScript, "utf16le").toString("base64");
  const command = [
    "$ErrorActionPreference='Stop'",
    "$dir='C:\\data\\mail-intake'",
    "[IO.Directory]::CreateDirectory($dir)|Out-Null",
    `$stdout=Join-Path $dir 'dispatch-${launchKey}.stdout.log'`,
    `$stderr=Join-Path $dir 'dispatch-${launchKey}.stderr.log'`,
    `$process=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${encodedDelivery}') -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru`,
    `[pscustomobject]@{accepted=$true;process_id=$process.Id}|ConvertTo-Json -Compress`,
  ].join("; ");
  await orgoBash(config, command);
  const logPath = `C:\\data\\mail-intake\\dispatch-${launchKey}`;

  // Poll the detached POST's stdout for the gateway acceptance.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const stdout = await orgoBash(
      config,
      `Get-Content '${logPath}.stdout.log' -Raw -ErrorAction SilentlyContinue`,
    ).catch(() => "");
    if (/"status"\s*:\s*"accepted"/i.test(stdout)) {
      logger.info({ messageId: input.messageId }, "Gateway accepted PDF extraction request");
      return;
    }
    const stderr = await orgoBash(
      config,
      `Get-Content '${logPath}.stderr.log' -Raw -ErrorAction SilentlyContinue`,
    ).catch(() => "");
    if (/unable to connect|actively refused|timed out|could not be resolved/i.test(stderr)) {
      throw new PdfTransportError(`Gateway rejected extraction delivery: ${stderr.slice(0, 200)}`);
    }
  }
  throw new PdfTransportError("Gateway never acknowledged the extraction request");
}

/** Constant-time-ish HMAC check for the extraction callback. */
export function verifyExtractionCallback(
  rawBody: Buffer | string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
  toleranceMs = 300_000,
): boolean {
  if (!timestampHeader || !signatureHeader) return false;
  const timestampSec = Number(timestampHeader);
  if (!Number.isFinite(timestampSec)) return false;
  if (Math.abs(nowMs - timestampSec * 1000) > toleranceMs) return false;
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(`${timestampHeader}.${body}`).digest("hex");
  if (signatureHeader.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}
