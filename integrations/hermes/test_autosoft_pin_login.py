import argparse
import ctypes
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import autosoft_pin_login as target


class AutoSoftPinLoginTests(unittest.TestCase):
    def test_input_structure_matches_native_windows_abi(self):
        expected_size = 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28
        self.assertEqual(ctypes.sizeof(target.INPUT), expected_size)

    def test_executes_one_secret_submission_without_returning_pin(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = argparse.Namespace(
                expected_title="colu64.autosoftflex.com:7069",
                request_id="batch:7:1:vehicle",
                attempt_root=Path(temporary),
            )
            with (
                patch.object(target, "foreground_rdp_title", return_value="authorized RDP"),
                patch.object(target, "read_credential", return_value="1234"),
                patch.object(target, "send_secret") as send_secret,
            ):
                result = target.execute(args)
            send_secret.assert_called_once_with("1234")
            self.assertEqual(result, {"ok": True, "submitted": True, "verification_required": True})
            self.assertNotIn("1234", str(result))

    def test_refuses_a_second_attempt_for_the_same_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target.claim_attempt("batch:7:1:vehicle", root)
            with self.assertRaisesRegex(RuntimeError, "already attempted"):
                target.claim_attempt("batch:7:1:vehicle", root)

    def test_rejects_malformed_request_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(RuntimeError, "invalid dashboard request ID"):
                target.claim_attempt("bad request", Path(temporary))


if __name__ == "__main__":
    unittest.main()
