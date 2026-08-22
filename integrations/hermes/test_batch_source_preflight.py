import json
import os
import subprocess
import sys
from pathlib import Path

from openpyxl import Workbook


SCRIPT = Path(__file__).with_name("batch_source_preflight.py")


def save_book(path: Path, headers: list[str], rows: list[list[object]]) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(headers)
    for row in rows:
        sheet.append(row)
    workbook.save(path)


def run_helper(tmp_path: Path, nextgear: Path, stock_sheet: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--vin",
            "WP1AA2A59KLB00525",
            "--vin",
            "W1N0G8DBXNV374754",
            "--nextgear-export",
            str(nextgear),
            "--stock-sheet",
            str(stock_sheet),
            "--output",
            str(tmp_path / "result.json"),
        ],
        text=True,
        capture_output=True,
    )


def test_accepts_recent_unique_in_stock_rows(tmp_path: Path) -> None:
    nextgear = tmp_path / "Exportable Inventory.xlsx"
    stock_sheet = tmp_path / "Columbia.xlsx"
    save_book(
        nextgear,
        ["Vehicle Status", "Description", "VIN", "Stock Number", "Source", "Financed"],
        [
            ["In Stock", "2019 PORSCHE MACAN", "WP1AA2A59KLB00525", "16534", "Auction", 18320],
            ["In Stock", "2022 MERCEDES GLC", "W1N0G8DBXNV374754", "16533", "Auction", 18530],
        ],
    )
    save_book(stock_sheet, ["Stock", "VIN"], [["S2424", "KMHRC8A36PU224300"]])

    completed = run_helper(tmp_path, nextgear, stock_sheet)
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))

    assert completed.returncode == 0
    assert result["ready"] is True
    assert result["nextgear"]["vehicles"]["WP1AA2A59KLB00525"]["match_count"] == 1
    assert result["target_store_sheet"]["vehicles"]["WP1AA2A59KLB00525"]["match_count"] == 0


def test_rejects_stale_or_duplicate_nextgear_rows(tmp_path: Path) -> None:
    nextgear = tmp_path / "Exportable Inventory.xlsx"
    stock_sheet = tmp_path / "Columbia.xlsx"
    save_book(
        nextgear,
        ["Vehicle Status", "VIN"],
        [
            ["In Stock", "WP1AA2A59KLB00525"],
            ["In Stock", "WP1AA2A59KLB00525"],
            ["In Stock", "W1N0G8DBXNV374754"],
        ],
    )
    save_book(stock_sheet, ["Stock", "VIN"], [])
    old = 10 * 3600
    os.utime(nextgear, (nextgear.stat().st_atime - old, nextgear.stat().st_mtime - old))

    completed = run_helper(tmp_path, nextgear, stock_sheet)
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))

    assert completed.returncode == 2
    assert result["ready"] is False
    assert result["nextgear"]["all_unique"] is False
    assert result["nextgear"]["age_ok"] is False
