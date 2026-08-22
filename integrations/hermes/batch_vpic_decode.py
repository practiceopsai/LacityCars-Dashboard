#!/usr/bin/env python3
"""Decode an ordered VIN batch with NHTSA vPIC into one stable JSON artifact."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import urlopen


VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")
FIELDS = (
    "VIN",
    "ModelYear",
    "Make",
    "Model",
    "Trim",
    "BodyClass",
    "VehicleType",
    "DriveType",
    "EngineCylinders",
    "ErrorCode",
    "ErrorText",
)


def normalize_vin(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def decode_vin(vin: str, timeout: float = 30) -> dict[str, object]:
    url = (
        "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/"
        f"{quote(vin)}?format=json"
    )
    with urlopen(url, timeout=timeout) as response:
        body = json.load(response)
    results = body.get("Results") or []
    if len(results) != 1:
        raise ValueError(f"vPIC returned {len(results)} rows for {vin}")
    record = results[0]
    decoded = {field: record.get(field) for field in FIELDS}
    decoded["VIN"] = normalize_vin(str(decoded.get("VIN") or vin))
    decoded["valid"] = decoded["VIN"] == vin and str(decoded.get("ErrorCode") or "") in {"0", ""}
    return decoded


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vin", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=30)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    vins = [normalize_vin(value) for value in args.vin]
    errors: list[str] = []
    if len(vins) != len(set(vins)):
        errors.append("duplicate VIN supplied")
    invalid = [vin for vin in vins if not VIN_RE.fullmatch(vin)]
    if invalid:
        errors.append("invalid VIN format: " + ", ".join(invalid))

    decoded: list[dict[str, object]] = []
    if not errors:
        try:
            decoded = [decode_vin(vin, args.timeout) for vin in vins]
        except (ValueError, OSError, HTTPError, URLError, json.JSONDecodeError) as exc:
            errors.append(str(exc))
    ready = not errors and all(item["valid"] for item in decoded)
    result = {"ready": ready, "ordered_vins": vins, "vehicles": decoded, "errors": errors}
    atomic_json(args.output, result)
    print(json.dumps({"ready": ready, "count": len(decoded), "output": str(args.output.resolve())}))
    return 0 if ready else 2


if __name__ == "__main__":
    sys.exit(main())
