"use client";

import { useEffect, useState } from "react";
import { api, type StoreDto } from "@/lib/api";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";

interface ChargeRow {
  label: string;
  amount: string;
}

interface StoreDraft {
  code: string;
  name: string;
  aliases: string;
  stockPrefix: string;
  autosoftInstance: string;
  rdpWindowTitle: string;
  charges: ChargeRow[];
  chargesTotal: string;
  active: boolean;
  isNew?: boolean;
}

function toDraft(store: StoreDto): StoreDraft {
  return {
    code: store.code,
    name: store.name,
    aliases: store.aliases.join(", "),
    stockPrefix: store.stockPrefix,
    autosoftInstance: store.autosoftInstance,
    rdpWindowTitle: store.rdpWindowTitle,
    charges: store.internalCharges.map((c) => ({ label: c.label, amount: String(c.amount) })),
    chargesTotal: String(store.chargesTotal),
    active: store.active,
  };
}

const EMPTY_DRAFT: StoreDraft = {
  code: "",
  name: "",
  aliases: "",
  stockPrefix: "",
  autosoftInstance: "",
  rdpWindowTitle: "",
  charges: [{ label: "Pack", amount: "0" }],
  chargesTotal: "0",
  active: true,
  isNew: true,
};

function computedTotal(draft: StoreDraft): number {
  return draft.charges.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
}

function StoreForm({ draft: initial, onSaved }: { draft: StoreDraft; onSaved: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const total = computedTotal(draft);
  const declared = Number(draft.chargesTotal) || 0;
  const mismatch = total !== declared;

  function setCharge(i: number, patch: Partial<ChargeRow>) {
    setDraft((d) => ({
      ...d,
      charges: d.charges.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));
  }

  async function save() {
    setBusy(true);
    setFlash(null);
    const body = {
      code: draft.code.trim().toUpperCase(),
      name: draft.name.trim(),
      aliases: draft.aliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
      stockPrefix: draft.stockPrefix.trim().toUpperCase(),
      autosoftInstance: draft.autosoftInstance.trim(),
      rdpWindowTitle: draft.rdpWindowTitle.trim(),
      internalCharges: draft.charges.map((c) => ({
        label: c.label.trim(),
        amount: Number(c.amount) || 0,
      })),
      chargesTotal: declared,
      active: draft.active,
    };
    try {
      if (draft.isNew) {
        await api("/api/stores", { method: "POST", body });
      } else {
        await api(`/api/stores/${body.code}`, { method: "PUT", body });
      }
      setFlash({ kind: "success", text: "Store saved." });
      onSaved();
    } catch (err) {
      setFlash({ kind: "error", text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>{draft.isNew ? "New store" : `${draft.name} (${draft.code})`}</h2>
      {flash ? (
        <div className={`alert alert-${flash.kind === "success" ? "success" : "error"}`} role="alert">
          {flash.text}
        </div>
      ) : null}
      <div className="grid-2">
        <label className="field">
          <span>Store code</span>
          <input
            type="text"
            value={draft.code}
            disabled={!draft.isNew}
            onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
            placeholder="E.g. RIVERSIDE"
          />
          {draft.isNew ? <p className="field-hint">UPPER_SNAKE_CASE; permanent once created.</p> : null}
        </label>
        <label className="field">
          <span>Display name</span>
          <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>Aliases (comma-separated, matched at intake)</span>
        <input type="text" value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>Stock prefix</span>
          <input
            type="text"
            value={draft.stockPrefix}
            maxLength={3}
            onChange={(e) => setDraft({ ...draft, stockPrefix: e.target.value.toUpperCase() })}
          />
        </label>
        <label className="field">
          <span>AutoSoft instance</span>
          <input
            type="text"
            value={draft.autosoftInstance}
            onChange={(e) => setDraft({ ...draft, autosoftInstance: e.target.value })}
          />
        </label>
      </div>
      <label className="field">
        <span>RDP window title</span>
        <input
          type="text"
          value={draft.rdpWindowTitle}
          onChange={(e) => setDraft({ ...draft, rdpWindowTitle: e.target.value })}
          placeholder="Stable native RDP title, e.g. colu64.autosoftflex.com"
        />
        <p className="field-hint">Used only to acquire the correct shared desktop; the AutoSoft instance above is verified inside the session.</p>
      </label>

      <h2 style={{ marginTop: 8 }}>Internal charges</h2>
      {draft.charges.map((charge, i) => (
        <div className="charge-row" key={i}>
          <label>
            <span className="sr-only">Charge {i + 1} label</span>
            <input
              type="text"
              value={charge.label}
              placeholder="Label"
              onChange={(e) => setCharge(i, { label: e.target.value })}
            />
          </label>
          <label>
            <span className="sr-only">Charge {i + 1} amount</span>
            <input
              type="number"
              value={charge.amount}
              min={0}
              step={1}
              onChange={(e) => setCharge(i, { amount: e.target.value })}
            />
          </label>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            aria-label={`Remove charge ${charge.label || i + 1}`}
            onClick={() =>
              setDraft((d) => ({ ...d, charges: d.charges.filter((_, j) => j !== i) }))
            }
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setDraft((d) => ({ ...d, charges: [...d.charges, { label: "", amount: "0" }] }))}
      >
        + Add charge
      </button>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <label className="field">
          <span>Declared total</span>
          <input
            type="number"
            value={draft.chargesTotal}
            min={0}
            step={1}
            className={mismatch ? "input-error" : ""}
            onChange={(e) => setDraft({ ...draft, chargesTotal: e.target.value })}
            aria-describedby={`total-check-${draft.code || "new"}`}
          />
        </label>
        <div className="field">
          <span
            style={{
              display: "block",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--muted)",
              marginBottom: 4,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Computed total
          </span>
          <p id={`total-check-${draft.code || "new"}`} style={{ margin: "6px 0 0" }}>
            <strong style={{ color: mismatch ? "var(--red)" : "var(--green)" }}>${total}</strong>
            {mismatch ? (
              <span className="field-error"> — must equal the declared total (${declared}) before saving</span>
            ) : (
              <span className="field-hint"> — matches ✓</span>
            )}
          </p>
        </div>
      </div>

      <div className="toolbar">
        <button type="button" className="btn btn-primary" disabled={busy || mismatch} onClick={save}>
          {busy ? "Saving…" : "Save store"}
        </button>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
          />
          Active (available at intake)
        </label>
      </div>
    </div>
  );
}

export default function StoresPage() {
  const [stores, setStores] = useState<StoreDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    try {
      const data = await api<{ items: StoreDto[] }>("/api/stores");
      setStores(data.items);
      setError(null);
    } catch {
      setError("Could not load stores.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Store Settings</h1>
          <p className="sub">
            Aliases, stock prefixes, and internal charge schedules. No credentials or accounting
            PINs are stored here.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => setShowNew((v) => !v)}>
          {showNew ? "Cancel new store" : "+ Add store"}
        </button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : stores === null ? (
        <LoadingState label="Loading stores…" />
      ) : (
        <>
          {showNew ? (
            <StoreForm
              draft={EMPTY_DRAFT}
              onSaved={() => {
                setShowNew(false);
                void load();
              }}
            />
          ) : null}
          {stores.length === 0 && !showNew ? (
            <EmptyState message="No stores configured yet." />
          ) : (
            stores.map((store) => (
              <StoreForm key={`${store.code}:${store.updatedAt}`} draft={toDraft(store)} onSaved={() => void load()} />
            ))
          )}
        </>
      )}
    </>
  );
}
