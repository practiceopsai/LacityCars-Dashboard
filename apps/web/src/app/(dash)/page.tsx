"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type StoreDto, type VehicleDto, type VehicleListDto } from "@/lib/api";
import { useVehicleStream } from "@/lib/sse";
import { VehicleCard } from "@/components/VehicleCard";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";

const LANES: { key: string; title: string; accent: string; statuses: VehicleDto["status"][] }[] = [
  {
    key: "awaiting",
    title: "Awaiting Freight",
    accent: "lane-accent-amber",
    statuses: ["PENDING", "AWAITING_FREIGHT"],
  },
  {
    key: "active",
    title: "Ready / Processing",
    accent: "lane-accent-blue",
    statuses: ["READY", "PROCESSING"],
  },
  {
    key: "action",
    title: "Action Required",
    accent: "lane-accent-red",
    statuses: ["ACTION_REQUIRED", "FAILED"],
  },
];

export default function CommandCenterPage() {
  const [vehicles, setVehicles] = useState<VehicleDto[] | null>(null);
  const [stores, setStores] = useState<StoreDto[]>([]);
  const [storeFilter, setStoreFilter] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (storeFilter) params.set("store", storeFilter);
      if (search.trim()) params.set("search", search.trim());
      const data = await api<VehicleListDto>(`/api/vehicles?${params}`);
      setVehicles(data.items.filter((v) => v.status !== "COMPLETED"));
      setError(null);
    } catch {
      setError("Could not load vehicles.");
    }
  }, [storeFilter, search]);

  // SSE events arrive in bursts; debounce the refetch.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void load();
    }, 400);
  }, [load]);
  const streamState = useVehicleStream(scheduleRefresh);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<{ items: StoreDto[] }>("/api/stores")
      .then((data) => setStores(data.items))
      .catch(() => setStores([]));
  }, []);

  const lanes = useMemo(
    () =>
      LANES.map((lane) => ({
        ...lane,
        vehicles: (vehicles ?? []).filter((v) => lane.statuses.includes(v.status)),
      })),
    [vehicles],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Command Center</h1>
          <p className="sub">Live stocking workflow across all stores</p>
        </div>
        <div className="toolbar">
          <span
            className={`live-dot ${streamState === "live" ? "" : "degraded"}`}
            role="status"
            aria-live="polite"
          >
            {streamState === "live" ? "Live" : streamState === "polling" ? "Polling" : "Connecting…"}
          </span>
          <label className="sr-only" htmlFor="cc-store">
            Filter by store
          </label>
          <select id="cc-store" value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}>
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="cc-search">
            Search vehicles
          </label>
          <input
            id="cc-search"
            type="search"
            placeholder="Search VIN, stock #, model…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : vehicles === null ? (
        <LoadingState label="Loading board…" />
      ) : (
        <div className="kanban">
          {lanes.map((lane) => (
            <section key={lane.key} className={`lane ${lane.accent}`} aria-label={lane.title}>
              <div className="lane-head">
                <h2>{lane.title}</h2>
                <span className="lane-count">{lane.vehicles.length}</span>
              </div>
              {lane.vehicles.length === 0 ? (
                <EmptyState message="Nothing here right now." />
              ) : (
                lane.vehicles.map((v) => <VehicleCard key={v.id} vehicle={v} />)
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
