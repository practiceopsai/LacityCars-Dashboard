#!/usr/bin/env python3
"""Build compact, deterministic batch evidence from cached workbook exports.

The helper is intentionally read-only.  It lets Hermes prove that one recent
NextGear Exportable Inventory workbook contains every requested VIN exactly
once and scan only the target store's stock sheet for duplicate rows.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import openpyxl


VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")


def normalize_vin(value: object) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def compact_value(value: object) -> object:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def header_key(value: object, index: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())
    return text or f"column_{index + 1}"


def scan_workbook(path: Path, vins: list[str]) -> dict[str, Any]:
    targets = set(vins)
    matches: dict[str, list[dict[str, Any]]] = {vin: [] for vin in vins}
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        for sheet in workbook.worksheets:
            rows = list(sheet.iter_rows(values_only=True))
            header_index = None
            headers: list[str] = []
            for index, row in enumerate(rows[:75]):
                normalized = {
                    re.sub(r"[^a-z0-9]", "", str(value or "").lower())
                    for value in row
                }
                if "vin" in normalized or "vehiclenumber" in normalized:
                    header_index = index
                    headers = [header_key(value, column) for column, value in enumerate(row)]
                    break

            for row_index, row in enumerate(rows, start=1):
                row_vins = {normalize_vin(value) for value in row}
                found = targets.intersection(row_vins)
                if not found:
                    continue
                if header_index is not None and row_index - 1 > header_index:
                    fields = {
                        headers[column] if column < len(headers) else f"column_{column + 1}": compact_value(value)
                        for column, value in enumerate(row)
                        if value not in (None, "")
                    }
                else:
                    fields = {
                        f"column_{column + 1}": compact_value(value)
                        for column, value in enumerate(row)
                        if value not in (None, "")
                    }
                for vin in found:
                    matches[vin].append(
                        {"sheet": sheet.title, "row": row_index, "fields": fields}
                    )
    finally:
        workbook.close()
    return matches


def field_value(fields: dict[str, Any], *names: str) -> str:
    wanted = {re.sub(r"[^a-z0-9]", "", name.lower()) for name in names}
    for key, value in fields.items():
        if re.sub(r"[^a-z0-9]", "", key.lower()) in wanted:
            return str(value or "").strip()
    return ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vin", action="append", required=True)
    parser.add_argument("--nextgear-export", type=Path, required=True)
    parser.add_argument("--stock-sheet", type=Path, required=True)
    parser.add_argument("--max-nextgear-age-hours", type=float, default=6.0)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    vins = [normalize_vin(value) for value in args.vin]
    errors: list[str] = []
    if len(vins) != len(set(vins)):
        errors.append("duplicate VIN supplied")
    invalid = [vin for vin in vins if not VIN_RE.fullmatch(vin)]
    if invalid:
        errors.append("invalid VIN(s): " + ", ".join(invalid))
    for label, path in (("NextGear export", args.nextgear_export), ("stock sheet", args.stock_sheet)):
        if not path.is_file():
            errors.append(f"{label} not found: {path}")

    if errors:
        result: dict[str, Any] = {"ready": False, "errors": errors}
    else:
        nextgear_matches = scan_workbook(args.nextgear_export, vins)
        stock_matches = scan_workbook(args.stock_sheet, vins)
        age_hours = (
            datetime.now(timezone.utc).timestamp() - args.nextgear_export.stat().st_mtime
        ) / 3600
        nextgear_rows: dict[str, Any] = {}
        for vin, rows in nextgear_matches.items():
            status = field_value(rows[0]["fields"], "Vehicle Status", "Status") if len(rows) == 1 else ""
            nextgear_rows[vin] = {
                "match_count": len(rows),
                "vehicle_status": status,
                "matches": rows,
            }

        unique = all(item["match_count"] == 1 for item in nextgear_rows.values())
        in_stock = all(
            item["vehicle_status"].lower() == "in stock"
            for item in nextgear_rows.values()
        )
        age_ok = age_hours <= args.max_nextgear_age_hours
        result = {
            "ready": unique and in_stock and age_ok,
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "nextgear": {
                "path": str(args.nextgear_export.resolve()),
                "age_hours": round(age_hours, 3),
                "max_age_hours": args.max_nextgear_age_hours,
                "age_ok": age_ok,
                "all_unique": unique,
                "all_in_stock": in_stock,
                "vehicles": nextgear_rows,
            },
            "target_store_sheet": {
                "path": str(args.stock_sheet.resolve()),
                "vehicles": {
                    vin: {"match_count": len(rows), "matches": rows}
                    for vin, rows in stock_matches.items()
                },
            },
            "errors": [],
        }

    text = json.dumps(result, indent=2, ensure_ascii=False)
    if args.output:
        args.output.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0 if result.get("ready") else 2


if __name__ == "__main__":
    sys.exit(main())
