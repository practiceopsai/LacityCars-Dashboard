"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type StoreDto, type VehicleListDto } from "@/lib/api";
import { fmtDate, fmtMoney } from "@/lib/format";
import { VinDisplay } from "@/components/VinDisplay";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";

const PAGE_SIZE = 25;

export default function LedgerPage() {
  const [data, setData] = useState<VehicleListDto | null>(null);
  const [stores, setStores] = useState<StoreDto[]>([]);
  const [storeFilter, setStoreFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(() => {
    const params = new URLSearchParams({
      status: "COMPLETED",
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (storeFilter) params.set("store", storeFilter);
    if (search.trim()) params.set("search", search.trim());
    return params;
  }, [page, storeFilter, search]);

  const load = useCallback(async () => {
    try {
      setData(await api<VehicleListDto>(`/api/vehicles?${query()}`));
      setError(null);
    } catch {
      setError("Could not load the completed ledger.");
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<{ items: StoreDto[] }>("/api/stores")
      .then((d) => setStores(d.items))
      .catch(() => {});
  }, []);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const exportParams = new URLSearchParams();
  if (storeFilter) exportParams.set("store", storeFilter);
  if (search.trim()) exportParams.set("search", search.trim());

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Completed Ledger</h1>
          <p className="sub">Accounting record of every vehicle Hermes has finished</p>
        </div>
        <div className="toolbar">
          <label className="sr-only" htmlFor="lg-store">
            Filter by store
          </label>
          <select
            id="lg-store"
            value={storeFilter}
            onChange={(e) => {
              setStoreFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="lg-search">
            Search
          </label>
          <input
            id="lg-search"
            type="search"
            placeholder="Search VIN, stock #, model…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <a className="btn" href={`/api/vehicles/export.csv?${exportParams}`} download>
            Export CSV
          </a>
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : data === null ? (
        <LoadingState label="Loading ledger…" />
      ) : data.items.length === 0 ? (
        <EmptyState message="No completed vehicles match these filters yet." />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stock #</th>
                  <th>VIN</th>
                  <th>Store</th>
                  <th>Model</th>
                  <th>Completed</th>
                  <th className="num">ACV</th>
                  <th className="num">Freight</th>
                  <th className="num">Final Total</th>
                  <th>RAG Ref</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((v) => (
                  <tr key={v.id}>
                    <td>{v.stockNumber ?? "—"}</td>
                    <td>
                      <VinDisplay vin={v.vin} masked={v.vinMasked} />
                    </td>
                    <td>{v.store.name}</td>
                    <td>
                      <a href={`/vehicles/${v.id}`}>{v.model}</a>
                    </td>
                    <td>{fmtDate(v.completedAt)}</td>
                    <td className="num">{fmtMoney(v.acv)}</td>
                    <td className="num">{fmtMoney(v.freightAmount)}</td>
                    <td className="num">{fmtMoney(v.finalTotal)}</td>
                    <td className="vin">{v.ragCommitId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span>
              {data.total} completed · page {data.page} of {totalPages}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Prev
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </>
  );
}
