"""Send a signed stocking result from Hermes to the dashboard.

The callback secret is read only from LACITY_DASHBOARD_CALLBACK_SECRET. It is
never accepted on the command line, written into a result file, or printed.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


VALID_STATUSES = {"PROCESSING", "COMPLETED", "FAILED"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--callback-url", required=True)
    parser.add_argument("--payload-file", type=Path)
    parser.add_argument("--request-id")
    parser.add_argument("--vin")
    parser.add_argument("--status", choices=sorted(VALID_STATUSES))
    parser.add_argument("--stock-number")
    parser.add_argument("--freight-amount", type=float)
    parser.add_argument("--final-total", type=float)
    parser.add_argument("--acv", type=float)
    parser.add_argument("--rag-commit-id")
    parser.add_argument("--failure-reason")
    parser.add_argument("--failure-scope", choices=("VEHICLE", "BATCH"), default="VEHICLE")
    parser.add_argument("--run-summary")
    parser.add_argument("--delivery-id")
    return parser.parse_args()


def validate_callback_url(value: str) -> str:
    expected_origin = os.environ.get("LACITY_DASHBOARD_CALLBACK_ORIGIN", "").rstrip("/")
    expected = f"{expected_origin}/api/webhooks/hermes"
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("callback URL must be HTTPS")
    if not expected_origin or value.rstrip("/") != expected:
        raise ValueError("callback URL does not match the configured dashboard origin")
    return expected


def build_payload(args: argparse.Namespace) -> dict[str, object]:
    if args.payload_file:
        payload = json.loads(args.payload_file.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("payload file must contain a JSON object")
    else:
        payload = {
            key: value
            for key, value in {
                "request_id": args.request_id,
                "vin": args.vin,
                "status": args.status,
                "stock_number": args.stock_number,
                "freight_amount": args.freight_amount,
                "final_total": args.final_total,
                "acv": args.acv,
                "rag_commit_id": args.rag_commit_id,
                "failure_reason": args.failure_reason,
                "failure_scope": args.failure_scope,
                "run_summary": args.run_summary,
            }.items()
            if value is not None
        }

    for key in ("request_id", "vin", "status"):
        if not payload.get(key):
            raise ValueError(f"callback payload requires {key}")
    if payload["status"] not in VALID_STATUSES:
        raise ValueError("invalid callback status")
    return payload


def main() -> int:
    args = parse_args()
    try:
        callback_url = validate_callback_url(args.callback_url)
        payload = build_payload(args)
        secret = os.environ.get("LACITY_DASHBOARD_CALLBACK_SECRET", "")
        if len(secret) < 16:
            raise ValueError("LACITY_DASHBOARD_CALLBACK_SECRET is not configured")

        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        signature = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        request = Request(
            callback_url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Hermes-Signature": signature,
                "X-Hermes-Delivery": args.delivery_id or str(uuid.uuid4()),
            },
        )
        with urlopen(request, timeout=30) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            print(f"dashboard callback accepted: HTTP {response.status} {response_body[:300]}")
        return 0
    except (ValueError, OSError, json.JSONDecodeError, HTTPError, URLError) as exc:
        print(f"dashboard callback failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
