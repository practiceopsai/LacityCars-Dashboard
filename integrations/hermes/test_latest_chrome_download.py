import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from integrations.hermes.latest_chrome_download import (
    CHROME_EPOCH_OFFSET_SECONDS,
    resolve_download,
)


def chrome_time(value: datetime) -> int:
    return int((value.timestamp() + CHROME_EPOCH_OFFSET_SECONDS) * 1_000_000)


class LatestChromeDownloadTests(unittest.TestCase):
    def test_resolves_browser_use_workspace_download_after_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            profile = Path(temporary)
            workspace = profile / "AppData" / "Local" / "hermes" / "cache" / "browser-use" / "workspace" / "old-session"
            workspace.mkdir(parents=True)
            workbook = workspace / "STOCK SHEET LA CITY CARS.xlsx"
            workbook.write_bytes(b"PK\x03\x04fresh-workbook")
            history = profile / "History"
            connection = sqlite3.connect(history)
            connection.execute(
                """CREATE TABLE downloads (
                    id INTEGER, current_path TEXT, target_path TEXT,
                    start_time INTEGER, end_time INTEGER, received_bytes INTEGER,
                    total_bytes INTEGER, state INTEGER, interrupt_reason INTEGER
                )"""
            )
            started = datetime(2026, 8, 23, 5, 0, tzinfo=timezone.utc)
            connection.execute(
                "INSERT INTO downloads VALUES (1,?,?,?,?,?,?,?,?)",
                (str(workbook), str(workbook), chrome_time(started), chrome_time(started), workbook.stat().st_size, workbook.stat().st_size, 1, 0),
            )
            connection.commit()
            connection.close()

            result = resolve_download(
                history,
                "STOCK SHEET LA CITY CARS",
                datetime(2026, 8, 23, 4, 59, tzinfo=timezone.utc),
                profile,
            )
            self.assertTrue(result["ready"])
            self.assertEqual(Path(result["path"]), workbook.resolve())

    def test_rejects_old_or_outside_download(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            profile = Path(temporary)
            outside = profile / "Desktop" / "STOCK SHEET LA CITY CARS.xlsx"
            outside.parent.mkdir(parents=True)
            outside.write_bytes(b"PK\x03\x04old-workbook")
            history = profile / "History"
            connection = sqlite3.connect(history)
            connection.execute(
                """CREATE TABLE downloads (
                    id INTEGER, current_path TEXT, target_path TEXT,
                    start_time INTEGER, end_time INTEGER, received_bytes INTEGER,
                    total_bytes INTEGER, state INTEGER, interrupt_reason INTEGER
                )"""
            )
            started = datetime(2026, 8, 23, 4, 0, tzinfo=timezone.utc)
            connection.execute(
                "INSERT INTO downloads VALUES (1,?,?,?,?,?,?,?,?)",
                (str(outside), str(outside), chrome_time(started), chrome_time(started), outside.stat().st_size, outside.stat().st_size, 1, 0),
            )
            connection.commit()
            connection.close()

            result = resolve_download(
                history,
                "STOCK SHEET LA CITY CARS",
                datetime(2026, 8, 23, 4, 30, tzinfo=timezone.utc),
                profile,
            )
            self.assertFalse(result["ready"])


if __name__ == "__main__":
    unittest.main()
