#!/usr/bin/env python3
"""Post PDF-extraction results back to the mail-intake service, HMAC-signed.

One purpose: the email-intake gateway route's agent writes its extracted rows
to a JSON file, then runs this helper exactly once. The helper reads the
callback secret from C:\\data\\mail-intake\\callback-secret.txt (never from the
prompt, transcript, or environment of the agent), signs `<timestamp>.<body>`
with HMAC-SHA256, and POSTs to <callback_url>. It prints one JSON line with
the outcome and never prints the secret.

Usage:
  python extraction_callback.py --callback-url URL --request-id ID --result-file PATH
Result file shape (authored by the agent via ordinary file writes):
  {"vehicles": [{"vin": "...", "model": "...", "store": null, "source": "...",
                 "stock_number": null, "page": 1}],
   "warnings": ["..."]}
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import sys
import time
import urllib.request

SECRET_PATH = r"C:\data\mail-intake\callback-secret.txt"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--callback-url", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--result-file", required=True)
    args = parser.parse_args()

    try:
        with open(SECRET_PATH, "r", encoding="utf-8-sig") as handle:
            secret = handle.read().strip()
    except OSError as err:
        print(json.dumps({"ok": False, "error": f"secret file unreadable: {err}"}))
        return 1
    if len(secret) < 32:
        print(json.dumps({"ok": False, "error": "callback secret too short"}))
        return 1

    try:
        with open(args.result_file, "r", encoding="utf-8-sig") as handle:
            result = json.load(handle)
    except (OSError, json.JSONDecodeError) as err:
        print(json.dumps({"ok": False, "error": f"result file invalid: {err}"}))
        return 1

    payload = {
        "request_id": args.request_id,
        "vehicles": result.get("vehicles", []),
        "warnings": result.get("warnings", []),
    }
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    timestamp = str(int(time.time()))
    signature = hmac.new(secret.encode("utf-8"), f"{timestamp}.".encode("utf-8") + body,
                         hashlib.sha256).hexdigest()

    request = urllib.request.Request(
        args.callback_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Webhook-Timestamp": timestamp,
            "X-Webhook-Signature-V2": signature,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode("utf-8", errors="replace")
            accepted = '"accepted"' in text
            print(json.dumps({"ok": accepted, "status": response.status, "body": text[:200]}))
            return 0 if accepted else 1
    except Exception as err:  # noqa: BLE001 - single reporting point
        print(json.dumps({"ok": False, "error": str(err)[:300]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
