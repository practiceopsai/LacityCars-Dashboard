"use client";

import Link from "next/link";
import {
  EASTERN_TIME_ZONE,
  PACIFIC_TIME_ZONE,
  formatStockingTime,
} from "@lacity/shared";
import type { VehicleDto } from "@/lib/api";
import { fmtMoney, timeUntil } from "@/lib/format";
import { StatusBadge } from "./StatusBadge";
import { VinDisplay } from "./VinDisplay";

export function VehicleCard({ vehicle }: { vehicle: VehicleDto }) {
  return (
    <div className="vcard">
      <div className="vcard-top">
        <span className="vcard-store">{vehicle.store.name}</span>
        <StatusBadge status={vehicle.status} />
      </div>
      <div className="vcard-model">
        <Link href={`/vehicles/${vehicle.id}`}>{vehicle.model}</Link>
      </div>
      <VinDisplay vin={vehicle.vin} masked={vehicle.vinMasked} />
      <div className="vcard-meta">
        {vehicle.scheduledStartAt ? (
          <span>
            Starts {formatStockingTime(vehicle.scheduledStartAt, EASTERN_TIME_ZONE)} /{" "}
            {formatStockingTime(vehicle.scheduledStartAt, PACIFIC_TIME_ZONE)}
          </span>
        ) : null}
        {vehicle.stockNumber ? <span>Stock {vehicle.stockNumber}</span> : null}
        {vehicle.freightAmount !== null ? (
          <span>Freight {fmtMoney(vehicle.freightAmount)}</span>
        ) : null}
        {vehicle.status === "AWAITING_FREIGHT" && vehicle.nextFreightCheckAt ? (
          <span>
            Next check {timeUntil(vehicle.nextFreightCheckAt)} · attempt {vehicle.freightAttempts}
          </span>
        ) : null}
      </div>
      {vehicle.failureReason &&
      (vehicle.status === "FAILED" || vehicle.status === "ACTION_REQUIRED") ? (
        <div className="vcard-fail">{vehicle.failureReason}</div>
      ) : null}
    </div>
  );
}
