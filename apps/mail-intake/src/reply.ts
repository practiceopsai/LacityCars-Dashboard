import { EASTERN_TIME_ZONE, formatStockingTime, type IntakeVehicle } from "@lacity/shared";
import type { IntakeItemResultDto } from "./intakeClient";
import type { RowProblem } from "./validate";

/** Build the staff-facing reply: what queued, what was already known, what needs fixing. */

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TABLE_STYLE = 'border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:10.5pt"';
const HEAD_STYLE = 'style="background-color:#1F4E79;color:#ffffff;font-weight:bold"';

export interface ReplyInput {
  submitted: IntakeVehicle[];
  results: IntakeItemResultDto[];
  problems: RowProblem[];
  warnings: string[];
  scheduledAt: string;
  dryRun: boolean;
}

export function buildReply(input: ReplyInput): { text: string; html: string } {
  const when = formatStockingTime(input.scheduledAt, EASTERN_TIME_ZONE);
  const byVin = new Map(input.results.map((r) => [r.vin, r]));
  const queued: Array<{ vehicle: IntakeVehicle; result?: IntakeItemResultDto }> = [];
  const duplicates: Array<{ vehicle: IntakeVehicle; result: IntakeItemResultDto }> = [];
  const rejected: Array<{ vehicle: IntakeVehicle; result: IntakeItemResultDto }> = [];

  for (const vehicle of input.submitted) {
    const result = byVin.get(vehicle.vin);
    if (input.dryRun || !result) {
      queued.push({ vehicle, result });
    } else if (!result.ok) {
      rejected.push({ vehicle, result });
    } else if (result.duplicate) {
      duplicates.push({ vehicle, result });
    } else {
      queued.push({ vehicle, result });
    }
  }

  const textLines: string[] = [];
  const htmlParts: string[] = [];
  const heading = input.dryRun
    ? "TEST MODE — parsed only, nothing was queued. Live status below reflects what WOULD happen."
    : `Received. Vehicles below are queued for the ${when} stocking run.`;
  textLines.push(heading, "");
  htmlParts.push(`<p style="font-family:Calibri,Arial,sans-serif">${esc(heading)}</p>`);

  if (queued.length > 0) {
    textLines.push(`QUEUED (${queued.length}):`);
    htmlParts.push(`<p><b>Queued (${queued.length})</b></p><table ${TABLE_STYLE}><tr ${HEAD_STYLE}><td>VIN</td><td>Vehicle</td><td>Store</td><td>Source</td></tr>`);
    for (const { vehicle } of queued) {
      textLines.push(`  ${vehicle.vin}  ${vehicle.model}  ${vehicle.store}${vehicle.source ? `  (${vehicle.source})` : ""}`);
      htmlParts.push(`<tr><td>${esc(vehicle.vin)}</td><td>${esc(vehicle.model)}</td><td>${esc(vehicle.store)}</td><td>${esc(vehicle.source ?? "—")}</td></tr>`);
    }
    htmlParts.push("</table>");
    textLines.push("");
  }

  if (duplicates.length > 0) {
    textLines.push(`ALREADY IN THE SYSTEM (${duplicates.length}) — not queued again:`);
    htmlParts.push(`<p><b>Already in the system (${duplicates.length})</b> — not queued again</p><table ${TABLE_STYLE}><tr ${HEAD_STYLE}><td>VIN</td><td>Vehicle</td><td>Current status</td></tr>`);
    for (const { vehicle, result } of duplicates) {
      textLines.push(`  ${vehicle.vin}  ${vehicle.model}  (${result.status ?? "in progress"})`);
      htmlParts.push(`<tr><td>${esc(vehicle.vin)}</td><td>${esc(vehicle.model)}</td><td>${esc(result.status ?? "in progress")}</td></tr>`);
    }
    htmlParts.push("</table>");
    textLines.push("");
  }

  const needsFixing = [
    ...input.problems.map((p) => ({
      vin: p.row.vin,
      origin: p.row.origin,
      reasons: p.reasons,
    })),
    ...rejected.map(({ vehicle, result }) => ({
      vin: vehicle.vin,
      origin: "submitted",
      reasons: result.errors ?? ["Rejected by the dashboard"],
    })),
  ];
  if (needsFixing.length > 0) {
    textLines.push(`NEEDS FIXING (${needsFixing.length}) — NOT queued; please correct and resend:`);
    htmlParts.push(`<p><b style="color:#9C0006">Needs fixing (${needsFixing.length})</b> — NOT queued; please correct and resend</p><table ${TABLE_STYLE}><tr ${HEAD_STYLE}><td>VIN (as sent)</td><td>Where</td><td>Problem</td></tr>`);
    for (const item of needsFixing) {
      textLines.push(`  ${item.vin} [${item.origin}]: ${item.reasons.join("; ")}`);
      htmlParts.push(`<tr style="background-color:#FFF2CC"><td>${esc(item.vin)}</td><td>${esc(item.origin)}</td><td>${esc(item.reasons.join("; "))}</td></tr>`);
    }
    htmlParts.push("</table>");
    textLines.push("");
  }

  if (input.warnings.length > 0) {
    textLines.push("Notes:", ...input.warnings.map((w) => `  - ${w}`));
    htmlParts.push(`<p style="color:#666;font-size:9.5pt">${input.warnings.map(esc).join("<br>")}</p>`);
  }

  return { text: textLines.join("\n"), html: htmlParts.join("\n") };
}

export function buildNoVehiclesReply(reason: string): { text: string; html: string } {
  const text = `No vehicles were queued from this email.\n\n${reason}\n\nSend the vehicles as an Excel/CSV attachment with a VIN column (plus model/store/source), or a PDF, and name the store (LA City or Columbia City) in the subject.`;
  return { text, html: `<p style="font-family:Calibri,Arial,sans-serif">${esc(text).replace(/\n/g, "<br>")}</p>` };
}
