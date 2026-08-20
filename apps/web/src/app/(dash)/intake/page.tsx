"use client";

import { useEffect, useMemo, useState } from "react";
import {
  EASTERN_TIME_ZONE,
  PACIFIC_TIME_ZONE,
  stockingScheduleLabels,
  validateVin,
  zonedLocalToIso,
  type StockingTimeZone,
} from "@lacity/shared";
import { api, type IntakeResultDto, type StoreDto } from "@/lib/api";
import { mapCsvRows, parseCsv, type CsvVehicleRow } from "@/lib/csv";

export default function IntakePage() {
  const [stores, setStores] = useState<StoreDto[]>([]);
  const [store, setStore] = useState("");
  const [vin, setVin] = useState("");
  const [model, setModel] = useState("");
  const [stockNumber, setStockNumber] = useState("");
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [scheduleZone, setScheduleZone] = useState<StockingTimeZone>(EASTERN_TIME_ZONE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const [csvRows, setCsvRows] = useState<CsvVehicleRow[] | null>(null);
  const [csvResults, setCsvResults] = useState<IntakeResultDto | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [batchName, setBatchName] = useState("");
  const [transportReference, setTransportReference] = useState("");

  useEffect(() => {
    api<{ items: StoreDto[] }>("/api/stores")
      .then((d) => {
        setStores(d.items.filter((s) => s.active));
        if (d.items.length > 0) setStore(d.items[0]!.code);
      })
      .catch(() => setMessage({ kind: "error", text: "Could not load stores." }));
  }, []);

  const vinCheck = useMemo(() => (vin.trim() ? validateVin(vin) : null), [vin]);
  const schedule = useMemo(() => {
    if (!scheduleLocal) return null;
    try {
      const iso = zonedLocalToIso(scheduleLocal, scheduleZone);
      if (Date.parse(iso) <= Date.now()) return { ok: false, error: "Choose a future start time." } as const;
      return { ok: true, iso, labels: stockingScheduleLabels(iso) } as const;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Invalid start time." } as const;
    }
  }, [scheduleLocal, scheduleZone]);

  async function submitSingle(e: React.FormEvent) {
    e.preventDefault();
    if (!vinCheck?.ok || !schedule?.ok) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<IntakeResultDto>("/api/vehicles/intake", {
        method: "POST",
        body: {
          store,
          vin: vinCheck.vin,
          model: model.trim(),
          scheduledAt: schedule.iso,
          ...(stockNumber.trim() ? { stockNumber: stockNumber.trim() } : {}),
        },
      });
      const item = result.results[0];
      if (item?.ok && item.duplicate) {
        setMessage({
          kind: "success",
          text: `VIN already active for this store (status ${item.status}). No duplicate created.`,
        });
      } else if (item?.ok) {
        setMessage({ kind: "success", text: `Vehicle accepted — freight verification queued.` });
        setVin("");
        setModel("");
        setStockNumber("");
      } else {
        setMessage({ kind: "error", text: item?.errors?.join("; ") ?? "Intake failed." });
      }
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Intake failed." });
    } finally {
      setBusy(false);
    }
  }

  function handleCsvText(text: string) {
    setCsvResults(null);
    const rows = mapCsvRows(parseCsv(text));
    setCsvRows(rows.length > 0 ? rows : null);
    if (rows.length === 0) {
      setMessage({ kind: "error", text: "No data rows found in that CSV." });
    }
  }

  async function onCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    handleCsvText(await file.text());
    e.target.value = "";
  }

  const validCsvRows = (csvRows ?? []).filter((r) => r.errors.length === 0);

  async function submitCsv() {
    if (validCsvRows.length === 0 || !schedule?.ok || (validCsvRows.length > 1 && !batchName.trim())) return;
    setCsvBusy(true);
    setCsvResults(null);
    try {
      const vehicles = validCsvRows.map((r) => ({
        store: r.store,
        vin: r.vin,
        model: r.model,
        ...(r.stockNumber ? { stockNumber: r.stockNumber } : {}),
      }));
      const result = await api<IntakeResultDto>(
        validCsvRows.length > 1 ? "/api/batches/intake" : "/api/vehicles/intake",
        {
        method: "POST",
        body:
          validCsvRows.length > 1
            ? {
                name: batchName.trim(),
                ...(transportReference.trim() ? { transportReference: transportReference.trim() } : {}),
                scheduledAt: schedule.iso,
                vehicles,
              }
            : { ...vehicles[0]!, scheduledAt: schedule.iso },
        },
      );
      setCsvResults(result);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Bulk intake failed." });
    } finally {
      setCsvBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Intake</h1>
          <p className="sub">Submit vehicles for freight verification and Hermes processing</p>
        </div>
      </div>

      {message ? (
        <div className={`alert alert-${message.kind === "success" ? "success" : "error"}`} role="alert">
          {message.text}
        </div>
      ) : null}

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Stocking start time</h2>
        <p className="field-hint">
          Required for every submission. Freight may be prepared earlier, but Hermes cannot open the
          stock sheet or shared AutoSoft account before this time. One time applies to the whole CSV batch.
        </p>
        <div className="grid-2">
          <label className="field">
            <span>Date and time</span>
            <input
              type="datetime-local"
              value={scheduleLocal}
              onChange={(e) => setScheduleLocal(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Time zone entered</span>
            <select
              value={scheduleZone}
              onChange={(e) => setScheduleZone(e.target.value as StockingTimeZone)}
            >
              <option value={EASTERN_TIME_ZONE}>Eastern (ET)</option>
              <option value={PACIFIC_TIME_ZONE}>Pacific (PT)</option>
            </select>
          </label>
        </div>
        {schedule?.ok ? (
          <p className="field-hint">
            Eastern: {schedule.labels.eastern} · Pacific: {schedule.labels.pacific}
          </p>
        ) : schedule ? (
          <p className="field-error">{schedule.error}</p>
        ) : (
          <p className="field-hint">The equivalent Eastern and Pacific times will appear here.</p>
        )}
      </div>

      <div className="grid-2">
        <form className="panel" onSubmit={submitSingle}>
          <h2>Single vehicle</h2>
          <label className="field">
            <span>Store</span>
            <select value={store} onChange={(e) => setStore(e.target.value)} required>
              {stores.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} (prefix {s.stockPrefix})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>VIN (17 characters)</span>
            <input
              type="text"
              value={vin}
              onChange={(e) => setVin(e.target.value.toUpperCase())}
              className={vinCheck && !vinCheck.ok ? "input-error" : ""}
              spellCheck={false}
              autoComplete="off"
              maxLength={25}
              required
              aria-describedby="vin-feedback"
            />
            <div id="vin-feedback">
              {vinCheck && !vinCheck.ok ? (
                <p className="field-error">{vinCheck.errors.join(" · ")}</p>
              ) : vinCheck?.ok ? (
                <p className="field-hint">✓ Valid VIN: {vinCheck.vin}</p>
              ) : (
                <p className="field-hint">Pasted VINs are normalized (case, spaces, dashes).</p>
              )}
            </div>
          </label>
          <label className="field">
            <span>Model</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. 2022 Honda Accord EX-L"
              required
            />
          </label>
          <label className="field">
            <span>Stock # (optional)</span>
            <input type="text" value={stockNumber} onChange={(e) => setStockNumber(e.target.value)} />
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !vinCheck?.ok || !model.trim() || !store || !schedule?.ok}
          >
            {busy ? "Submitting…" : "Submit vehicle"}
          </button>
        </form>

        <div className="panel">
          <h2>Bulk CSV import</h2>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Columns: <code>store, vin, model, stock</code> (header row optional; store accepts code,
            name, or alias). Multi-row files become store-specific execution batches that share one
            transport group and run sequentially in AutoSoft.
          </p>
          <label className="field">
            <span>Batch name (required for multiple vehicles)</span>
            <input
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              placeholder="e.g. Riverside load 13552023"
            />
          </label>
          <label className="field">
            <span>Transport/load reference (optional)</span>
            <input
              value={transportReference}
              onChange={(e) => setTransportReference(e.target.value)}
              placeholder="e.g. 13552023"
            />
          </label>
          <label className="field">
            <span>CSV file</span>
            <input type="file" accept=".csv,text/csv" onChange={onCsvFile} />
          </label>
          <label className="field">
            <span>…or paste CSV</span>
            <textarea
              placeholder={"LA,1HGCM82633A004352,2022 Honda Accord\nColumbia,..."}
              onBlur={(e) => e.target.value.trim() && handleCsvText(e.target.value)}
            />
          </label>

          {csvRows ? (
            <>
              <div className="table-wrap" style={{ maxHeight: 300, overflowY: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Store</th>
                      <th>VIN</th>
                      <th>Model</th>
                      <th>Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvRows.map((r) => (
                      <tr key={r.rowNumber}>
                        <td>{r.rowNumber}</td>
                        <td>{r.store || "—"}</td>
                        <td className="vin">{r.vin || "—"}</td>
                        <td>{r.model || "—"}</td>
                        <td>
                          {r.errors.length > 0 ? (
                            <span className="field-error">{r.errors.join("; ")}</span>
                          ) : (
                            "✓"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="field-hint">
                {validCsvRows.length} of {csvRows.length} rows ready to submit.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  csvBusy ||
                  validCsvRows.length === 0 ||
                  !schedule?.ok ||
                  (validCsvRows.length > 1 && !batchName.trim())
                }
                onClick={submitCsv}
              >
                {csvBusy ? "Submitting…" : `Submit ${validCsvRows.length} vehicles`}
              </button>
            </>
          ) : null}

          {csvResults ? (
            <div style={{ marginTop: 12 }}>
              <div className="alert alert-success" role="status">
                Created {csvResults.summary.created} · duplicates {csvResults.summary.duplicates} ·
                rejected {csvResults.summary.rejected}
              </div>
              {csvResults.results.some((r) => !r.ok) ? (
                <ul>
                  {csvResults.results
                    .filter((r) => !r.ok)
                    .map((r, i) => (
                      <li key={i} className="field-error">
                        {r.vin}: {r.errors?.join("; ")}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
