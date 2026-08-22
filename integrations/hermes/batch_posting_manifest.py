#!/usr/bin/env python3
"""Build a validated posting manifest and sheet clipboard blocks.

This replaces ad-hoc ``python -c``/hand-authored JSON during headless Hermes
runs.  It only writes local artifacts; it never opens or changes a live sheet.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


PASSENGER_CAR = "PASSENGER CAR"
SOURCE_ALIASES = {
    "SOUTH FLORIDA AUTO AUCTION OF FT. LAUDERDALE, LLC": "S FL AUTO AUCTION",
    "MYCENTRALAUCTION": "MY CENTRAL AUCTION",
}


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(value, encoding="utf-8")
    temporary.replace(path)


def atomic_json(path: Path, value: object) -> None:
    atomic_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def section(text: str, name: str) -> str:
    match = re.search(
        rf"(?ms)^{re.escape(name)}:\s*\n(?P<body>(?:^[ \t]+.*(?:\n|$)|^\s*$)*)",
        text,
    )
    if not match:
        raise ValueError(f"store registry is missing {name}")
    return match.group("body")


def scalar(text: str, name: str, *, required: bool = True) -> str | None:
    match = re.search(rf"(?m)^\s*{re.escape(name)}:\s*['\"]?([^\n'\"]+)['\"]?\s*$", text)
    if match:
        return match.group(1).strip()
    if required:
        raise ValueError(f"store registry is missing {name}")
    return None


def integer(text: str, name: str) -> int:
    value = scalar(text, name)
    if value is None or not re.fullmatch(r"-?\d+", value):
        raise ValueError(f"store registry {name} must be an integer")
    return int(value)


def inline_amounts(text: str) -> dict[str, dict[str, int] | int]:
    result: dict[str, dict[str, int] | int] = {}
    for line in text.splitlines():
        match = re.match(r"\s*(\w+):\s*\{\s*amount:\s*(\d+),\s*credit_gl:\s*(\d+)\s*\}", line)
        if match:
            result[match.group(1)] = {"amount": int(match.group(2)), "credit_gl": int(match.group(3))}
    result["total"] = integer(text, "total")
    return result


def parse_registry(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    autosoft = section(text, "autosoft")
    internals = section(text, "internals")
    stock_sheet = section(text, "stock_sheet")
    pattern = scalar(stock_sheet, "stock_pattern") or ""
    prefix_match = re.search(r"[A-Za-z]+", pattern)
    if not prefix_match:
        raise ValueError("stock_pattern does not contain a stock prefix")
    return {
        "name": scalar(text, "display_name"),
        "instance": scalar(autosoft, "instance_title"),
        "rdp_title": scalar(autosoft, "host"),
        "stock_prefix": prefix_match.group(0),
        "used_car_line": scalar(autosoft, "used_car_line"),
        "used_truck_line": scalar(autosoft, "used_truck_line"),
        "used_car_inventory_gl": integer(autosoft, "used_car_inventory_gl"),
        "used_truck_inventory_gl": integer(autosoft, "used_truck_inventory_gl"),
        "floorplan_gl": integer(autosoft, "floorplan_gl"),
        "transport_gl": integer(autosoft, "transport_gl"),
        "internals": inline_amounts(internals),
    }


def normalized(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return re.sub(r"\s+", " ", str(value).strip()).upper()


def money(value: object) -> float:
    return round(float(value), 2)


def source_for_autosoft(value: str) -> str:
    upper = normalized(value)
    if upper in SOURCE_ALIASES:
        return SOURCE_ALIASES[upper]
    upper = upper.replace(" AUCTION OF ", " AUCTION ").replace(" AUTO AUCTION", " AUTO AUCTION")
    upper = re.sub(r"\bLIMITED LIABILITY COMPANY\b|\bLLC\b", "", upper)
    return re.sub(r"\s+", " ", upper).strip()[:25]


def parse_pairs(values: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"expected VIN=value, got {value!r}")
        vin, item = value.split("=", 1)
        vin = normalized(vin)
        item = normalized(item)
        if len(vin) != 17 or not item:
            raise ValueError(f"invalid VIN=value pair {value!r}")
        result[vin] = item
    return result


def description_model(description: str, year: int, make: str, fallback: str) -> str:
    value = normalized(description)
    prefix = f"{year} {normalized(make)} "
    if value.startswith(prefix):
        value = value[len(prefix) :]
    return value or normalized(fallback)


def groups(rows: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    result: list[list[dict[str, Any]]] = []
    for row in sorted(rows, key=lambda item: item["sheet_row"]):
        if not result or row["sheet_row"] != result[-1][-1]["sheet_row"] + 1:
            result.append([row])
        else:
            result[-1].append(row)
    return result


def build_blocks(output: Path, vehicles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pending = [item for item in vehicles if item["sheet_action"] == "APPEND_NEW"]
    blocks: list[dict[str, Any]] = []
    columns = {
        "B": lambda item: [item["stock_number"]],
        "D:I": lambda item: [
            item["vin"], item["year"], item["make"], item["model"], item["color"], item["mileage"]
        ],
        "K": lambda item: [item["acv"]],
    }
    for group in groups(pending):
        for columns_name, values_for in columns.items():
            rows = [values_for(item) for item in group]
            start = group[0]["sheet_row"]
            end = group[-1]["sheet_row"]
            suffix = columns_name.replace(":", "-")
            path = output.with_name(f"{output.stem}-sheet-{suffix}-{start}-{end}.tsv")
            atomic_text(path, "\n".join("\t".join(str(cell) for cell in row) for row in rows) + "\n")
            blocks.append(
                {
                    "columns": columns_name,
                    "row_start": start,
                    "row_end": end,
                    "range": f"{columns_name.split(':')[0]}{start}:{columns_name.split(':')[-1]}{end}",
                    "tsv_path": str(path.resolve()),
                    "row_count": len(rows),
                }
            )
    return blocks


def build(args: argparse.Namespace) -> dict[str, Any]:
    request = read_object(args.request)
    evidence = read_object(args.evidence)
    validation = read_object(args.validation)
    decode = read_object(args.decode)
    registry = parse_registry(args.store_registry)
    colors = parse_pairs(args.color)

    if not evidence.get("ready") or not validation.get("ready") or not decode.get("ready"):
        raise ValueError("evidence, validation, and decode artifacts must all be ready")
    request_id = str(request.get("request_id") or "")
    payload = request.get("vehicles") or []
    candidates = validation.get("sheet", {}).get("candidates") or []
    decoded = {normalized(item.get("VIN")): item for item in decode.get("vehicles") or []}
    evidence_by_vin = evidence.get("nextgear", {}).get("vehicles") or {}
    if len(payload) != len(candidates):
        raise ValueError("payload and validation candidate counts differ")

    candidate_by_vin = {normalized(item.get("vin")): item for item in candidates}
    if len(candidate_by_vin) != len(candidates):
        raise ValueError("validation contains duplicate VIN candidates")

    vehicles: list[dict[str, Any]] = []
    for order, payload_vehicle in enumerate(payload, start=1):
        vin = normalized(payload_vehicle.get("vin"))
        child_request_id = str(payload_vehicle.get("request_id") or "")
        if len(vin) != 17 or not child_request_id.startswith(request_id + ":"):
            raise ValueError(f"invalid current request identity for {vin or 'unknown VIN'}")
        candidate = candidate_by_vin.get(vin)
        decoded_vehicle = decoded.get(vin)
        ng = evidence_by_vin.get(vin)
        if not candidate or not decoded_vehicle or not ng or len(ng.get("matches") or []) != 1:
            raise ValueError(f"missing unique validation/evidence/decode data for {vin}")
        fields = ng["matches"][0].get("fields") or {}
        year = int(decoded_vehicle.get("ModelYear"))
        make = normalized(decoded_vehicle.get("Make"))
        model = description_model(fields.get("Vehicle Description", ""), year, make, decoded_vehicle.get("Model", ""))
        before = candidate.get("row_values_before") or []
        color = colors.get(vin) or (normalized(before[7]) if len(before) > 7 else "") or normalized(fields.get("Color"))
        if not color:
            raise ValueError(f"verified color is required for {vin}; pass --color {vin}=COLOR")
        mileage = int(float(fields["Odometer"]))
        acv = money(fields["Principal + One Day Loan"])
        freight = money((payload_vehicle.get("freight") or {}).get("amount"))
        freight_evidence = (payload_vehicle.get("freight") or {}).get("evidence") or {}
        source_full = str(fields.get("Source") or "").strip()
        if not source_full:
            raise ValueError(f"NextGear source is required for {vin}")
        is_car = normalized(decoded_vehicle.get("VehicleType")) == PASSENGER_CAR
        line = registry["used_car_line"] if is_car else registry["used_truck_line"]
        inventory_gl = registry["used_car_inventory_gl"] if is_car else registry["used_truck_inventory_gl"]
        internals = int(registry["internals"]["total"])
        vehicle = {
            "order": order,
            "request_id": child_request_id,
            "vin": vin,
            "stock_number": str(candidate["stock"]),
            "sheet_row": int(candidate["row"]),
            "sheet_action": candidate["sheet_action"],
            "year": year,
            "make": make,
            "model": model,
            "color": color,
            "mileage": mileage,
            "acv": acv,
            "freight": freight,
            "freight_evidence": (
                f"load {freight_evidence.get('loadId')}: {freight_evidence.get('loadPrice')} / "
                f"{freight_evidence.get('distinctVinCount')} distinct active VINs = {freight}; "
                f"dispatch row {','.join(str(value) for value in freight_evidence.get('matchedRowNumbers') or [])}"
            ),
            "source_full": source_full,
            "source_autosoft": source_for_autosoft(source_full),
            "body_class": decoded_vehicle.get("BodyClass"),
            "body_authority": "NHTSA vPIC clean VIN decode",
            "line": line,
            "inventory_gl": inventory_gl,
            "internals": internals,
            "expected_total": money(acv + freight + internals),
            "sheet_status": "VERIFIED_EXISTING_ROW" if candidate["sheet_action"] == "REUSE_EXISTING" else "READY_TO_APPEND",
            "autosoft_status": "PENDING",
        }
        if candidate["sheet_action"] == "REUSE_EXISTING":
            expected = [None, vehicle["stock_number"], None, vin, year, make, model, color, mileage, None, acv]
            for index in (1, 3, 4, 5, 6, 7, 8, 10):
                if len(before) <= index or normalized(before[index]) != normalized(expected[index]):
                    raise ValueError(f"existing sheet row mismatch for {vin} at column index {index}")
        vehicles.append(vehicle)

    result = {
        "schema": "vehicle-stock-in-posting-manifest/v1",
        "request_id": request_id,
        "store": {
            "name": registry["name"],
            "code": request.get("store", {}).get("code"),
            "autosoft_instance": registry["instance"],
            "rdp_window_title": registry["rdp_title"],
            "stock_prefix": registry["stock_prefix"],
            "floorplan_gl": registry["floorplan_gl"],
            "transport_gl": registry["transport_gl"],
            "internals": registry["internals"],
        },
        "sheet": {
            "plan_mode": validation.get("sheet", {}).get("plan_mode"),
            "source_export": validation.get("sheet", {}).get("path"),
            "blocks": [],
        },
        "vehicles": vehicles,
    }
    result["sheet"]["blocks"] = build_blocks(args.output, vehicles)
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--decode", type=Path, required=True)
    parser.add_argument("--store-registry", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--color", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = build(args)
        atomic_json(args.output, result)
        print(json.dumps({"ready": True, "output": str(args.output), "vehicles": len(result["vehicles"]), "blocks": len(result["sheet"]["blocks"])}))
        return 0
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError) as exc:
        print(f"posting manifest failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
