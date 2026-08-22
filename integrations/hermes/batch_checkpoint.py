#!/usr/bin/env python3
"""Create durable batch checkpoints and callback payloads without hand-written JSON."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


POSTED = "VERIFIED_POSTED"
FAILED = "FAILED"


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def as_money(value: object) -> float:
    return round(float(value), 2)


def find_vehicle(manifest: dict[str, Any], request_id: str, vin: str) -> dict[str, Any]:
    parent = str(manifest.get("request_id") or "")
    if not parent or not request_id.startswith(parent + ":"):
        raise ValueError("child request_id does not belong to the current manifest")
    matches = [
        item
        for item in manifest.get("vehicles") or []
        if item.get("request_id") == request_id and item.get("vin") == vin
    ]
    if len(matches) != 1:
        raise ValueError("manifest must contain exactly one matching request_id and VIN")
    return matches[0]


def require_equal(label: str, supplied: object, expected: object) -> None:
    if as_money(supplied) != as_money(expected):
        raise ValueError(f"{label} does not match the verified manifest")


def record(args: argparse.Namespace) -> int:
    manifest = read_object(args.manifest)
    vehicle = find_vehicle(manifest, args.request_id, args.vin)
    now = datetime.now(timezone.utc).isoformat()

    checkpoint: dict[str, Any] = {
        "schema": "vehicle-stock-in-checkpoint/v1",
        "parent_request_id": manifest["request_id"],
        "request_id": args.request_id,
        "vin": args.vin,
        "status": args.status,
        "recorded_at_utc": now,
        "run_summary": args.run_summary,
    }
    if args.status == POSTED:
        for name, supplied, expected in (
            ("stock_number", args.stock_number, vehicle.get("stock_number")),
            ("acv", args.acv, vehicle.get("acv")),
            ("freight", args.freight, vehicle.get("freight")),
            ("final_total", args.final_total, vehicle.get("expected_total")),
        ):
            if supplied is None or expected is None:
                raise ValueError(f"{name} is required for a posted checkpoint")
            if name == "stock_number":
                if str(supplied) != str(expected):
                    raise ValueError("stock_number does not match the verified manifest")
            else:
                require_equal(name, supplied, expected)
        checkpoint.update(
            {
                "stock_number": args.stock_number,
                "acv": as_money(args.acv),
                "freight_amount": as_money(args.freight),
                "final_total": as_money(args.final_total),
            }
        )
        vehicle["autosoft_status"] = POSTED
        vehicle["verification"] = {
            "status": POSTED,
            "readback_verified": True,
            "recorded_at_utc": now,
            "summary": args.run_summary,
        }
    else:
        if not args.failure_reason:
            raise ValueError("failure_reason is required for a failed checkpoint")
        checkpoint["failure_reason"] = args.failure_reason
        checkpoint["failure_scope"] = args.failure_scope
        if args.stock_number:
            checkpoint["stock_number"] = args.stock_number
        vehicle["autosoft_status"] = FAILED
        vehicle["verification"] = {
            "status": FAILED,
            "recorded_at_utc": now,
            "failure_reason": args.failure_reason,
            "summary": args.run_summary,
        }

    # Each replacement is atomic. Writing the checkpoint first makes an
    # interrupted update recoverable without ever losing the prior manifest.
    atomic_json(args.checkpoint_output, checkpoint)
    atomic_json(args.manifest, manifest)
    print(json.dumps({"recorded": True, "status": args.status, "vin": args.vin}))
    return 0


def git_output(rag_root: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(rag_root), *arguments],
        check=True,
        text=True,
        capture_output=True,
    )
    return completed.stdout.strip()


def relative_to_root(path: Path, root: Path) -> str:
    return str(path.resolve().relative_to(root.resolve())).replace("\\", "/")


def callback(args: argparse.Namespace) -> int:
    checkpoint = read_object(args.checkpoint)
    manifest = read_object(args.manifest)
    find_vehicle(manifest, str(checkpoint.get("request_id") or ""), str(checkpoint.get("vin") or ""))
    paths = [relative_to_root(args.checkpoint, args.rag_root), relative_to_root(args.manifest, args.rag_root)]
    if git_output(args.rag_root, "status", "--porcelain", "--", *paths):
        raise ValueError("checkpoint and manifest must be committed before callback generation")
    commit = git_output(args.rag_root, "rev-parse", "HEAD")
    status = checkpoint.get("status")
    payload: dict[str, Any] = {
        "request_id": checkpoint["request_id"],
        "vin": checkpoint["vin"],
        "status": "COMPLETED" if status == POSTED else "FAILED",
        "rag_commit_id": commit,
        "run_summary": checkpoint.get("run_summary"),
    }
    if checkpoint.get("stock_number"):
        payload["stock_number"] = checkpoint["stock_number"]
    if status == POSTED:
        payload.update(
            {
                "acv": checkpoint["acv"],
                "freight_amount": checkpoint["freight_amount"],
                "final_total": checkpoint["final_total"],
            }
        )
    else:
        payload["failure_reason"] = checkpoint["failure_reason"]
        payload["failure_scope"] = checkpoint.get("failure_scope", "VEHICLE")
    atomic_json(args.callback_output, payload)
    print(json.dumps({"callback_ready": True, "status": payload["status"], "vin": payload["vin"]}))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    record_parser = subparsers.add_parser("record")
    record_parser.add_argument("--manifest", type=Path, required=True)
    record_parser.add_argument("--request-id", required=True)
    record_parser.add_argument("--vin", required=True)
    record_parser.add_argument("--status", choices=(POSTED, FAILED), required=True)
    record_parser.add_argument("--checkpoint-output", type=Path, required=True)
    record_parser.add_argument("--stock-number")
    record_parser.add_argument("--acv", type=float)
    record_parser.add_argument("--freight", type=float)
    record_parser.add_argument("--final-total", type=float)
    record_parser.add_argument("--failure-reason")
    record_parser.add_argument("--failure-scope", choices=("VEHICLE", "BATCH"), default="VEHICLE")
    record_parser.add_argument("--run-summary", required=True)

    callback_parser = subparsers.add_parser("callback")
    callback_parser.add_argument("--manifest", type=Path, required=True)
    callback_parser.add_argument("--checkpoint", type=Path, required=True)
    callback_parser.add_argument("--callback-output", type=Path, required=True)
    callback_parser.add_argument("--rag-root", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        return record(args) if args.command == "record" else callback(args)
    except (ValueError, OSError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        print(f"batch checkpoint failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
