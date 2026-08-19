from __future__ import annotations

import argparse
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import dashboard_callback


class DashboardCallbackTests(unittest.TestCase):
    @patch.dict(
        os.environ,
        {"LACITY_DASHBOARD_CALLBACK_ORIGIN": "https://lacity-api-production.up.railway.app"},
        clear=False,
    )
    def test_accepts_only_the_configured_callback(self) -> None:
        expected = "https://lacity-api-production.up.railway.app/api/webhooks/hermes"
        self.assertEqual(dashboard_callback.validate_callback_url(expected), expected)
        with self.assertRaises(ValueError):
            dashboard_callback.validate_callback_url("https://attacker.example/api/webhooks/hermes")

    def test_builds_a_minimal_processing_payload(self) -> None:
        args = argparse.Namespace(
            payload_file=None,
            request_id="veh-1:0",
            vin="1HGCM82633A004352",
            status="PROCESSING",
            stock_number=None,
            freight_amount=None,
            final_total=None,
            acv=None,
            rag_commit_id=None,
            failure_reason=None,
            run_summary="Preflight started",
        )
        self.assertEqual(
            dashboard_callback.build_payload(args),
            {
                "request_id": "veh-1:0",
                "vin": "1HGCM82633A004352",
                "status": "PROCESSING",
                "run_summary": "Preflight started",
            },
        )

    def test_rejects_payload_files_without_required_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            path.write_text('{"status":"COMPLETED"}', encoding="utf-8")
            args = argparse.Namespace(payload_file=path)
            with self.assertRaises(ValueError):
                dashboard_callback.build_payload(args)


if __name__ == "__main__":
    unittest.main()
