from __future__ import annotations

import json
import subprocess
from argparse import Namespace
from pathlib import Path

import pytest

import batch_checkpoint


VIN = "4JGFB4KBXLA013794"
REQUEST_ID = "batch:6:3"


def write_manifest(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "request_id": "batch:6",
                "store": "Columbia City",
                "vehicles": [
                    {
                        "request_id": REQUEST_ID,
                        "vin": VIN,
                        "stock_number": "S2429",
                        "acv": 21150,
                        "freight": 500,
                        "expected_total": 23654,
                        "autosoft_status": "PENDING",
                        "verification": {},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def record_args(tmp_path: Path, **overrides) -> Namespace:
    values = {
        "manifest": tmp_path / "manifest.json",
        "request_id": REQUEST_ID,
        "vin": VIN,
        "status": batch_checkpoint.POSTED,
        "checkpoint_output": tmp_path / "checkpoint.json",
        "stock_number": "S2429",
        "acv": 21150,
        "freight": 500,
        "final_total": 23654,
        "failure_reason": None,
        "failure_scope": "VEHICLE",
        "run_summary": "Verified AutoSoft readback.",
    }
    values.update(overrides)
    return Namespace(**values)


def test_record_updates_one_exact_vehicle_and_writes_valid_checkpoint(tmp_path: Path) -> None:
    write_manifest(tmp_path / "manifest.json")
    args = record_args(tmp_path)

    assert batch_checkpoint.record(args) == 0
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    checkpoint = json.loads(args.checkpoint_output.read_text(encoding="utf-8"))
    assert manifest["vehicles"][0]["autosoft_status"] == "VERIFIED_POSTED"
    assert checkpoint["final_total"] == 23654
    assert checkpoint["vin"] == VIN


def test_record_rejects_amount_mismatch_without_mutating_files(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    write_manifest(manifest_path)
    before = manifest_path.read_text(encoding="utf-8")

    with pytest.raises(ValueError, match="final_total"):
        batch_checkpoint.record(record_args(tmp_path, final_total=23655))

    assert manifest_path.read_text(encoding="utf-8") == before
    assert not (tmp_path / "checkpoint.json").exists()


def test_callback_uses_committed_checkpoint_and_git_head(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "config", "user.email", "test@example.com"], check=True)
    write_manifest(tmp_path / "manifest.json")
    args = record_args(tmp_path)
    batch_checkpoint.record(args)
    subprocess.run(["git", "-C", str(tmp_path), "add", "manifest.json", "checkpoint.json"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "commit", "-qm", "checkpoint"], check=True)

    callback_path = tmp_path.parent / f"{tmp_path.name}-callback.json"
    result = batch_checkpoint.callback(
        Namespace(
            manifest=args.manifest,
            checkpoint=args.checkpoint_output,
            callback_output=callback_path,
            rag_root=tmp_path,
        )
    )

    assert result == 0
    payload = json.loads(callback_path.read_text(encoding="utf-8"))
    assert payload["status"] == "COMPLETED"
    assert payload["rag_commit_id"] == subprocess.check_output(
        ["git", "-C", str(tmp_path), "rev-parse", "HEAD"], text=True
    ).strip()


def test_callback_rejects_output_inside_rag_tree(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "config", "user.email", "test@example.com"], check=True)
    write_manifest(tmp_path / "manifest.json")
    args = record_args(tmp_path)
    batch_checkpoint.record(args)
    subprocess.run(["git", "-C", str(tmp_path), "add", "manifest.json", "checkpoint.json"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "commit", "-qm", "checkpoint"], check=True)

    with pytest.raises(ValueError, match="outside the RAG Git working tree"):
        batch_checkpoint.callback(
            Namespace(
                manifest=args.manifest,
                checkpoint=args.checkpoint_output,
                callback_output=tmp_path / "callback.json",
                rag_root=tmp_path,
            )
        )

    assert not (tmp_path / "callback.json").exists()
