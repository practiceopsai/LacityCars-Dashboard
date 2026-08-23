#!/usr/bin/env python3
"""Resolve a newly completed Chrome download to its real on-disk path.

Browser Use may place downloads in a session workspace instead of the user's
Downloads folder.  Selecting a file by directory/name therefore risks reusing
an older workbook.  This helper reads Chrome's completed-download ledger and
returns only a matching file created after the caller's current-run marker.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600


def parse_utc(value: str) -> datetime:
    normalized = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("--since-utc must include a timezone")
    return parsed.astimezone(timezone.utc)


def chrome_time_to_utc(value: int) -> datetime:
    unix_seconds = (int(value) / 1_000_000) - CHROME_EPOCH_OFFSET_SECONDS
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc)


def allowed_download_root(path: Path, user_profile: Path) -> bool:
    resolved = path.resolve()
    roots = (
        (user_profile / "Downloads").resolve(),
        (user_profile / "AppData" / "Local" / "hermes" / "cache" / "browser-use" / "workspace").resolve(),
    )
    return any(resolved == root or root in resolved.parents for root in roots)


def resolve_download(
    history_path: Path,
    filename_prefix: str,
    since_utc: datetime,
    user_profile: Path,
) -> dict[str, Any]:
    uri = f"file:{history_path.resolve().as_posix()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT id, current_path, target_path, start_time, end_time,
                   received_bytes, total_bytes, state, interrupt_reason
              FROM downloads
             WHERE state = 1
             ORDER BY start_time DESC
             LIMIT 250
            """
        ).fetchall()
    finally:
        connection.close()

    prefix = filename_prefix.casefold()
    for row in rows:
        started = chrome_time_to_utc(row["start_time"])
        if started < since_utc:
            break
        raw_path = row["current_path"] or row["target_path"] or ""
        candidate = Path(raw_path)
        if not candidate.name.casefold().startswith(prefix):
            continue
        if candidate.suffix.casefold() != ".xlsx":
            continue
        if not candidate.is_file() or not allowed_download_root(candidate, user_profile):
            continue
        size = candidate.stat().st_size
        if size < 4:
            continue
        with candidate.open("rb") as workbook:
            signature = workbook.read(4)
        if signature != b"PK\x03\x04":
            continue
        return {
            "ready": True,
            "path": str(candidate.resolve()),
            "filename": candidate.name,
            "started_at_utc": started.isoformat().replace("+00:00", "Z"),
            "bytes": size,
            "download_id": row["id"],
        }

    return {
        "ready": False,
        "error": "no completed matching Chrome download exists after the current-run marker",
        "filename_prefix": filename_prefix,
        "since_utc": since_utc.isoformat().replace("+00:00", "Z"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--filename-prefix", required=True)
    parser.add_argument("--since-utc", required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--history",
        type=Path,
        default=Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data" / "Default" / "History",
    )
    parser.add_argument(
        "--user-profile",
        type=Path,
        default=Path(os.environ.get("USERPROFILE", "")),
    )
    args = parser.parse_args()

    result = resolve_download(
        args.history,
        args.filename_prefix,
        parse_utc(args.since_utc),
        args.user_profile,
    )
    rendered = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
