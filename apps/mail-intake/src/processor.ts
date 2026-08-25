import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { MailIntakeConfig } from "./config";
import { logger } from "./logger";
import {
  bareAddress,
  getAttachment,
  getMessage,
  replyToMessage,
  sendMessage,
  type AgentMailMessage,
} from "./agentmail";
import { extractFromSpreadsheet, SpreadsheetParseError } from "./extract/spreadsheet";
import { triggerPdfExtraction, uploadPdfToVm } from "./extract/pdfHermes";
import type { ExtractedRow } from "./extract/types";
import { IntakeClient } from "./intakeClient";
import { buildNoVehiclesReply, buildReply } from "./reply";
import { nextStockingWindowIso } from "./schedule";
import { findStoreInText, validateRows } from "./validate";
import {
  jobKey,
  savePending,
  takePending,
  type FinalizeJobData,
  type MailIntakeJobData,
  type MessageJobData,
  type PendingExtraction,
} from "./queues";

export interface ProcessorDeps {
  config: MailIntakeConfig;
  redis: Redis;
  queue: Queue<MailIntakeJobData>;
  intakeClient?: IntakeClient;
}

const SPREADSHEET_RE = /\.(xlsx|csv)$/i;
const PDF_RE = /\.pdf$/i;

function allowlisted(config: MailIntakeConfig, sender: string): boolean {
  return config.STAFF_ALLOWLIST.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(sender);
}

async function alertOperator(
  config: MailIntakeConfig,
  subject: string,
  text: string,
): Promise<void> {
  try {
    await sendMessage(config, config.ALERT_EMAIL, subject, { text });
  } catch (err) {
    logger.error({ err }, "Failed to send operator alert");
  }
}

async function finalize(
  deps: ProcessorDeps,
  message: AgentMailMessage,
  rows: ExtractedRow[],
  warnings: string[],
): Promise<void> {
  const { config } = deps;
  const subject = message.subject ?? "";
  const contextText = `${subject}\n${message.text ?? ""}`;
  const fallbackStore = findStoreInText(contextText);
  const scheduledAt = nextStockingWindowIso();

  const { clean, problems } = validateRows(rows, fallbackStore, scheduledAt);
  if (clean.length === 0 && problems.length === 0) {
    const reply = buildNoVehiclesReply("No vehicle rows were found in the attachments.");
    await replyToMessage(config, message.message_id, reply);
    return;
  }

  const intakeClient = deps.intakeClient ?? new IntakeClient(config);
  const results = config.DRY_RUN || clean.length === 0
    ? { results: [], summary: { created: 0, duplicates: 0, rejected: 0 } }
    : await intakeClient.intake(clean);

  const reply = buildReply({
    submitted: clean,
    results: results.results,
    problems,
    warnings,
    scheduledAt,
    dryRun: config.DRY_RUN,
  });
  await replyToMessage(config, message.message_id, reply);

  if (problems.length > 0 && clean.length === 0) {
    await alertOperator(
      config,
      `Mail intake: every row bounced (${bareAddress(message.from ?? message.from_)})`,
      `Subject: ${subject}\nProblems:\n${problems
        .map((p) => `${p.row.vin} [${p.row.origin}]: ${p.reasons.join("; ")}`)
        .join("\n")}`,
    );
  }
  logger.info(
    {
      messageId: message.message_id,
      queued: results.summary.created,
      duplicates: results.summary.duplicates,
      bounced: problems.length,
      dryRun: config.DRY_RUN,
    },
    "Email intake finished",
  );
}

async function processMessage(deps: ProcessorDeps, job: Job<MessageJobData>): Promise<void> {
  const { config } = deps;
  const message = await getMessage(config, job.data.messageId);
  const sender = bareAddress(message.from ?? message.from_);

  if (!allowlisted(config, sender)) {
    logger.warn({ sender, subject: message.subject }, "Ignoring email from non-allowlisted sender");
    await alertOperator(
      config,
      "Mail intake: ignored email from unknown sender",
      `From: ${sender}\nSubject: ${message.subject ?? "(none)"}\nNo reply was sent and nothing was queued. Add the address to STAFF_ALLOWLIST if it should be allowed.`,
    );
    return;
  }

  const attachments = message.attachments ?? [];
  const spreadsheets = attachments.filter((a) => SPREADSHEET_RE.test(a.filename ?? ""));
  const pdfs = attachments.filter((a) => PDF_RE.test(a.filename ?? ""));
  const warnings: string[] = [];
  for (const other of attachments) {
    const name = other.filename ?? other.attachment_id;
    if (!SPREADSHEET_RE.test(name) && !PDF_RE.test(name)) {
      warnings.push(`Attachment "${name}" was skipped (only .xlsx, .csv, and .pdf are read)`);
    }
  }

  if (spreadsheets.length === 0 && pdfs.length === 0) {
    await replyToMessage(
      config,
      message.message_id,
      buildNoVehiclesReply("This email had no Excel/CSV or PDF attachment."),
    );
    return;
  }

  const rows: ExtractedRow[] = [];
  for (const meta of spreadsheets) {
    const buffer = await getAttachment(config, message.message_id, meta.attachment_id);
    if (buffer.length > config.MAX_ATTACHMENT_BYTES) {
      warnings.push(`Attachment "${meta.filename}" was skipped (too large)`);
      continue;
    }
    try {
      const extraction = await extractFromSpreadsheet(buffer, meta.filename ?? "attachment.xlsx");
      rows.push(...extraction.rows);
      warnings.push(...extraction.warnings);
    } catch (err) {
      if (err instanceof SpreadsheetParseError) {
        warnings.push(err.message);
      } else {
        throw err;
      }
    }
  }

  if (pdfs.length > 0) {
    const pdfPaths: string[] = [];
    for (const meta of pdfs) {
      const buffer = await getAttachment(config, message.message_id, meta.attachment_id);
      if (buffer.length > config.MAX_ATTACHMENT_BYTES) {
        warnings.push(`Attachment "${meta.filename}" was skipped (too large)`);
        continue;
      }
      pdfPaths.push(
        await uploadPdfToVm(config, message.message_id, meta.filename ?? "attachment.pdf", buffer),
      );
    }
    if (pdfPaths.length > 0) {
      const pending: PendingExtraction = {
        messageId: message.message_id,
        sender,
        subject: message.subject ?? "",
        fallbackStoreCode: findStoreInText(`${message.subject ?? ""}\n${message.text ?? ""}`),
        spreadsheetRows: rows,
        warnings,
        startedAt: new Date().toISOString(),
      };
      await savePending(deps.redis, pending);
      await triggerPdfExtraction(config, {
        messageId: message.message_id,
        subject: message.subject ?? "",
        bodyExcerpt: message.text ?? "",
        pdfPaths,
      });
      await deps.queue.add(
        "extraction-timeout",
        { kind: "extraction-timeout", messageId: message.message_id },
        { delay: config.EXTRACTION_TIMEOUT_MS, jobId: jobKey("timeout", message.message_id) },
      );
      logger.info(
        { messageId: message.message_id, pdfs: pdfPaths.length },
        "PDF extraction handed to Hermes; awaiting callback",
      );
      return;
    }
  }

  await finalize(deps, message, rows, warnings);
}

async function processFinalize(deps: ProcessorDeps, job: Job<FinalizeJobData>): Promise<void> {
  const pending = await takePending(deps.redis, job.data.messageId);
  if (!pending) {
    logger.warn({ messageId: job.data.messageId }, "Finalize with no pending record (already handled?)");
    return;
  }
  const message = await getMessage(deps.config, job.data.messageId);
  await finalize(
    deps,
    message,
    [...pending.spreadsheetRows, ...job.data.pdfRows],
    [...pending.warnings, ...job.data.pdfWarnings],
  );
}

async function processTimeout(
  deps: ProcessorDeps,
  job: Job<{ kind: "extraction-timeout"; messageId: string }>,
): Promise<void> {
  const pending = await takePending(deps.redis, job.data.messageId);
  if (!pending) return; // callback made it in time
  const { config } = deps;
  await replyToMessage(
    config,
    pending.messageId,
    buildNoVehiclesReply(
      "The PDF could not be read right now (the reader did not respond in time). Nothing was queued from the PDF — please resend the vehicles as an Excel/CSV attachment, or try again later.",
    ),
  );
  await alertOperator(
    config,
    "Mail intake: PDF extraction timed out",
    `Message ${pending.messageId} from ${pending.sender} ("${pending.subject}") — Hermes never called back. The sender was asked to resend as Excel.`,
  );
}

export function createMailProcessor(deps: ProcessorDeps) {
  return async (job: Job<MailIntakeJobData>): Promise<void> => {
    switch (job.data.kind) {
      case "message":
        return processMessage(deps, job as Job<MessageJobData>);
      case "finalize":
        return processFinalize(deps, job as Job<FinalizeJobData>);
      case "extraction-timeout":
        return processTimeout(deps, job as Job<ExtractionTimeoutJobData>);
      default:
        logger.warn({ data: job.data }, "Unknown mail-intake job kind");
    }
  };
}

type ExtractionTimeoutJobData = Extract<MailIntakeJobData, { kind: "extraction-timeout" }>;
