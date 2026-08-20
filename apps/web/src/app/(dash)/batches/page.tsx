"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EASTERN_TIME_ZONE,
  PACIFIC_TIME_ZONE,
  formatStockingTime,
} from "@lacity/shared";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { api, type StockingBatchDto } from "@/lib/api";

export default function BatchesPage() {
  const [items, setItems] = useState<StockingBatchDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await api<{ items: StockingBatchDto[] }>("/api/batches");
      setItems(result.items);
      setError(null);
    } catch {
      setError("Could not load stocking batches.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Stocking Batches</h1>
          <p className="sub">Transport groups split by store and processed sequentially in AutoSoft</p>
        </div>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : items === null ? (
        <LoadingState label="Loading batches…" />
      ) : items.length === 0 ? (
        <EmptyState message="No execution batches have been submitted yet." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Batch</th>
                <th>Store</th>
                <th>Transport</th>
                <th>Status</th>
                <th>Vehicles</th>
                <th>Scheduled ET</th>
                <th>Scheduled PT</th>
              </tr>
            </thead>
            <tbody>
              {items.map((batch) => (
                <tr key={batch.id}>
                  <td>{batch.name}</td>
                  <td>{batch.store.name}</td>
                  <td>{batch.transportReference ?? "—"}</td>
                  <td><span className="badge">{batch.status.replaceAll("_", " ")}</span></td>
                  <td>
                    {batch.vehicleCount} · {Object.entries(batch.counts)
                      .map(([status, count]) => `${count} ${status.toLowerCase()}`)
                      .join(" · ")}
                  </td>
                  <td>{formatStockingTime(batch.scheduledStartAt, EASTERN_TIME_ZONE)}</td>
                  <td>{formatStockingTime(batch.scheduledStartAt, PACIFIC_TIME_ZONE)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
