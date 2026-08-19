"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type VehicleDetailDto } from "@/lib/api";
import { fmtDateTime, fmtMoney, timeUntil } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { VinDisplay } from "@/components/VinDisplay";
import { ErrorState, LoadingState } from "@/components/states";

const RETRYABLE = ["ACTION_REQUIRED", "FAILED", "AWAITING_FREIGHT"];

interface Evidence {
  loadId?: string;
  loadPrice?: number;
  distinctVinCount?: number;
  vins?: string[];
  matchedRowNumbers?: number[];
  source?: string;
  fetchedAt?: string;
}

export default function VehicleDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [vehicle, setVehicle] = useState<VehicleDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [fixModel, setFixModel] = useState("");
  const [fixStock, setFixStock] = useState("");
  const [busy, setBusy] = useState<"retry" | "correction" | null>(null);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [flash, setFlash] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setVehicle(await api<VehicleDetailDto>(`/api/vehicles/${id}`));
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? "Vehicle not found."
          : "Could not load this vehicle.",
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function buildCorrections(): Record<string, string> | undefined {
    const fields: Record<string, string> = {};
    if (fixModel.trim()) fields.model = fixModel.trim();
    if (fixStock.trim()) fields.stock_number = fixStock.trim();
    return Object.keys(fields).length > 0 ? fields : undefined;
  }

  async function submitCorrection() {
    if (note.trim().length < 3) return;
    setBusy("correction");
    setFlash(null);
    try {
      await api(`/api/vehicles/${id}/corrections`, {
        method: "POST",
        body: { note: note.trim(), fields: buildCorrections() },
      });
      setFlash({ kind: "success", text: "Correction recorded — Hermes will see it on the next run." });
      setNote("");
      setFixModel("");
      setFixStock("");
      await load();
    } catch (err) {
      setFlash({ kind: "error", text: err instanceof Error ? err.message : "Failed to record correction." });
    } finally {
      setBusy(null);
    }
  }

  async function submitRetry() {
    if (note.trim().length < 5) {
      setFlash({ kind: "error", text: "Retry requires a correction/note (at least 5 characters)." });
      return;
    }
    setBusy("retry");
    setFlash(null);
    try {
      const result = await api<{ requeuedAs: string }>(`/api/vehicles/${id}/retry`, {
        method: "POST",
        body: { note: note.trim(), corrections: buildCorrections() },
      });
      setFlash({ kind: "success", text: `Vehicle requeued as ${result.requeuedAs}.` });
      setNote("");
      setConfirmRetry(false);
      await load();
    } catch (err) {
      setFlash({ kind: "error", text: err instanceof Error ? err.message : "Retry failed." });
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!vehicle) return <LoadingState label="Loading vehicle…" />;

  const evidence = (vehicle.freightEvidence ?? null) as Evidence | null;
  const retryable = RETRYABLE.includes(vehicle.status);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {vehicle.model} <StatusBadge status={vehicle.status} />
          </h1>
          <p className="sub">
            {vehicle.store.name} · <VinDisplay vin={vehicle.vin} masked={vehicle.vinMasked} />
            {vehicle.stockNumber ? ` · Stock ${vehicle.stockNumber}` : ""}
          </p>
        </div>
        <a className="btn" href="/">
          ← Back to board
        </a>
      </div>

      {flash ? (
        <div className={`alert alert-${flash.kind === "success" ? "success" : "error"}`} role="alert">
          {flash.text}
        </div>
      ) : null}
      {vehicle.failureReason ? (
        <div className="alert alert-error" role="alert">
          <strong>Failure reason:</strong> {vehicle.failureReason}
        </div>
      ) : null}

      <div className="grid-2">
        <div>
          <div className="panel">
            <h2>Freight</h2>
            {vehicle.freightAmount !== null && evidence ? (
              <dl className="kv">
                <dt>Per-car freight</dt>
                <dd>
                  <strong>{fmtMoney(vehicle.freightAmount)}</strong>
                </dd>
                <dt>Load</dt>
                <dd className="vin">{evidence.loadId}</dd>
                <dt>Whole load price</dt>
                <dd>{fmtMoney(evidence.loadPrice ?? null)}</dd>
                <dt>Divided across</dt>
                <dd>{evidence.distinctVinCount} distinct VINs</dd>
                <dt>VINs on load</dt>
                <dd className="vin">{(evidence.vins ?? []).join(", ")}</dd>
                <dt>Workbook rows</dt>
                <dd>{(evidence.matchedRowNumbers ?? []).join(", ")}</dd>
                <dt>Source</dt>
                <dd>{evidence.source}</dd>
                <dt>Checked</dt>
                <dd>{fmtDateTime(evidence.fetchedAt ?? null)}</dd>
              </dl>
            ) : (
              <dl className="kv">
                <dt>Status</dt>
                <dd>Not yet found on the dispatch workbook — freight is never estimated.</dd>
                <dt>Checks so far</dt>
                <dd>{vehicle.freightAttempts}</dd>
                <dt>Next check</dt>
                <dd>{timeUntil(vehicle.nextFreightCheckAt)}</dd>
              </dl>
            )}
          </div>

          <div className="panel">
            <h2>Hermes / Accounting</h2>
            <dl className="kv">
              <dt>ACV</dt>
              <dd>{fmtMoney(vehicle.acv)}</dd>
              <dt>Final total</dt>
              <dd>{fmtMoney(vehicle.finalTotal)}</dd>
              <dt>RAG commit</dt>
              <dd className="vin">{vehicle.ragCommitId ?? "—"}</dd>
              <dt>Completed</dt>
              <dd>{fmtDateTime(vehicle.completedAt)}</dd>
            </dl>
            {vehicle.runSummary ? (
              <>
                <h2 style={{ marginTop: 16 }}>Run summary</h2>
                <p style={{ whiteSpace: "pre-wrap", color: "var(--muted)", margin: 0 }}>
                  {vehicle.runSummary}
                </p>
              </>
            ) : null}
          </div>

          <div className="panel">
            <h2>Operator correction &amp; retry</h2>
            <label className="field">
              <span>Note (required for retry)</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What was wrong, and what did you fix?"
              />
            </label>
            <div className="grid-2">
              <label className="field">
                <span>Corrected model (optional)</span>
                <input type="text" value={fixModel} onChange={(e) => setFixModel(e.target.value)} />
              </label>
              <label className="field">
                <span>Corrected stock # (optional)</span>
                <input type="text" value={fixStock} onChange={(e) => setFixStock(e.target.value)} />
              </label>
            </div>
            <div className="toolbar">
              <button
                type="button"
                className="btn"
                disabled={busy !== null || note.trim().length < 3}
                onClick={submitCorrection}
              >
                {busy === "correction" ? "Saving…" : "Save correction only"}
              </button>
              {retryable ? (
                confirmRetry ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy !== null}
                      onClick={submitRetry}
                    >
                      {busy === "retry" ? "Requeueing…" : "Confirm retry"}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setConfirmRetry(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy !== null || note.trim().length < 5}
                    onClick={() => setConfirmRetry(true)}
                  >
                    Retry vehicle…
                  </button>
                )
              ) : (
                <span className="field-hint">
                  Retry is available for Action Required, Failed, or Awaiting Freight vehicles.
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="panel">
          <h2>Timeline</h2>
          {vehicle.timeline.length === 0 ? (
            <p className="field-hint">No events yet.</p>
          ) : (
            <ol className="timeline">
              {vehicle.timeline.map((event) => (
                <li key={event.id}>
                  <span className="tl-type">{event.type.replaceAll("_", " ")}</span>
                  {event.fromStatus && event.toStatus ? (
                    <span className="tl-time">
                      {event.fromStatus} → {event.toStatus}
                    </span>
                  ) : null}
                  <span className="tl-time">{fmtDateTime(event.createdAt)}</span>
                  {event.message ? <div className="tl-msg">{event.message}</div> : null}
                </li>
              ))}
            </ol>
          )}
          {vehicle.corrections.length > 0 ? (
            <>
              <h2 style={{ marginTop: 16 }}>Corrections</h2>
              <ol className="timeline">
                {vehicle.corrections.map((c) => (
                  <li key={c.id}>
                    <span className="tl-type">{c.createdBy ?? "operator"}</span>
                    <span className="tl-time">{fmtDateTime(c.createdAt)}</span>
                    <div className="tl-msg">
                      {c.note}
                      {c.fields ? ` — ${JSON.stringify(c.fields)}` : ""}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
