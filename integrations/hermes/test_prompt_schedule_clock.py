import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class PromptScheduleClockTests(unittest.TestCase):
    def test_webhook_prompt_requires_current_session_clock(self) -> None:
        prompt = (ROOT / "vehicle-ready-prompt.txt").read_text(encoding="utf-8")
        self.assertIn("fresh UTC clock value", prompt)
        self.assertIn("Never reuse or infer", prompt)
        self.assertIn("prior run log", prompt)
        self.assertIn("fresh clock is authoritative", prompt)

    def test_gateway_policy_carries_same_clock_boundary(self) -> None:
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        self.assertIn("fresh UTC clock command", configure)
        self.assertIn("Never reuse a timestamp from an earlier run", configure)


if __name__ == "__main__":
    unittest.main()
