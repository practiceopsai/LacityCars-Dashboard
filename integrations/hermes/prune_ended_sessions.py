#!/usr/bin/env python3
"""Remove only terminal Hermes routing entries from sessions.json.

Hermes normally performs this cleanup itself.  This recovery helper is for a
gateway caught repeatedly recreating terminal webhook sessions during startup.
It preserves active and unknown sessions, writes a timestamped backup, and
atomically replaces the routing file.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-db", required=True, type=Path)
    parser.add_argument("--sessions-json", required=True, type=Path)
    args = parser.parse_args()

    state_db = args.state_db.resolve()
    sessions_path = args.sessions_json.resolve()
    routes = json.loads(sessions_path.read_text(encoding="utf-8"))
    if not isinstance(routes, dict):
        raise ValueError("sessions.json must contain an object")

    connection = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True)
    try:
        ended: list[tuple[str, str, str | None]] = []
        for routing_key, record in routes.items():
            if not isinstance(record, dict):
                continue
            session_id = record.get("session_id")
            if not isinstance(session_id, str) or not session_id:
                continue
            row = connection.execute(
                "SELECT ended_at, end_reason FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if row is not None and row[0] is not None:
                ended.append((routing_key, session_id, row[1]))
    finally:
        connection.close()

    if not ended:
        print("no terminal routing entries found")
        return 0

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = sessions_path.with_name(f"{sessions_path.name}.bak.{stamp}")
    shutil.copy2(sessions_path, backup)
    for routing_key, _, _ in ended:
        routes.pop(routing_key, None)

    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{sessions_path.name}.", suffix=".tmp", dir=sessions_path.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(routes, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary_name, sessions_path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)

    print(
        json.dumps(
            {
                "removed": len(ended),
                "preserved": len(routes),
                "terminal_sessions": [
                    {"session_id": session_id, "end_reason": reason}
                    for _, session_id, reason in ended
                ],
                "backup": str(backup),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
