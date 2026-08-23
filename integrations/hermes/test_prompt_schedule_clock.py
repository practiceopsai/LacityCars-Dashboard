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

    def test_terminal_callback_is_the_last_side_effect(self) -> None:
        prompt = (ROOT / "vehicle-ready-prompt.txt").read_text(encoding="utf-8")
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        self.assertIn("accepted terminal callback is the final side effect", prompt)
        self.assertIn("accepted terminal callback is the final side effect", configure)
        self.assertIn("call no more tools", configure)

    def test_autosoft_currency_uses_dollar_values_not_implied_cents(self) -> None:
        prompt = (ROOT / "vehicle-ready-prompt.txt").read_text(encoding="utf-8")
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        for policy in (prompt, configure):
            self.assertIn("currency fields accept ordinary dollar values", policy)
            self.assertIn("`500.00` is typed as `500.00`, never `50000`", policy)
            self.assertNotIn("currency fields use implied cents", policy)

    def test_autosoft_readback_ignores_adjacent_line_selector_default(self) -> None:
        prompt = (ROOT / "vehicle-ready-prompt.txt").read_text(encoding="utf-8")
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        for policy in (prompt, configure):
            self.assertIn("9C 24300 USED CAR", policy)
            self.assertIn("two authoritative Line", policy)
            self.assertIn("saved Line or GL", policy)

    def test_post_save_reset_and_source_limit_are_explicit(self) -> None:
        prompt = (ROOT / "vehicle-ready-prompt.txt").read_text(encoding="utf-8")
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        for policy in (prompt, configure):
            self.assertIn("clean blank Vehicle Purchases form", policy)
            self.assertIn("Source accepts at most 20 characters", policy)
            self.assertIn("source_autosoft", policy)

    def test_post_direct_waits_for_async_inventory_job_before_classifying(self) -> None:
        prompt = (ROOT / "vehicle-ready-prompt.txt").read_text(encoding="utf-8")
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        for policy in (prompt, configure):
            self.assertIn("Post Direct` is asynchronous", policy)
            self.assertIn("select the current accounting period exactly once", policy)
            self.assertIn("Never click the period twice", policy)
            self.assertIn("Inventory > Vehicle Internals", policy)
            self.assertIn("zero original inventory, zero internals", policy)

    def test_headless_checkpoint_helper_has_narrow_allowlist(self) -> None:
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        self.assertIn(
            "Set-ConfigValue 'command_allowlist' '[\"python tools/batch_checkpoint.py *\"]'",
            configure,
        )

    def test_browser_use_reuses_one_approved_named_session(self) -> None:
        prompt = (ROOT / "vehicle-ready-prompt.txt").read_text(encoding="utf-8")
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        for policy in (prompt, configure):
            self.assertIn("fixed named session `vehicle-stocking`", policy)
            self.assertIn("never create an unnamed or alternate Browser Use session", policy)

    def test_browser_use_batches_site_work_and_reuses_authenticated_tab(self) -> None:
        prompt = (ROOT / "vehicle-ready-prompt.txt").read_text(encoding="utf-8")
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        for policy in (prompt, configure):
            self.assertIn("`timeout_s` of at least 300 seconds", policy)
            self.assertIn("one call MUST combine tab discovery, navigation, every VIN search", policy)
            self.assertIn("reuse the tab whose URL/title proves the authenticated NextGear dealer application", policy)
            self.assertIn("Never call `new_tab` for the public NextGear homepage", policy)
            self.assertIn("below 3,500 characters", policy)
            self.assertIn("exactly one compact JSON line", policy)
            self.assertIn("instead of retrying truncated code", policy)

    def test_configure_can_apply_policy_without_restarting_a_live_gateway(self) -> None:
        configure = (ROOT / "configure_orgo_webhook.ps1").read_text(encoding="utf-8")
        self.assertIn("[switch]$SkipGatewayRestart", configure)
        self.assertIn("gateway_restart_skipped = [bool]$SkipGatewayRestart", configure)
        self.assertIn("AddMinutes(10)", configure)


if __name__ == "__main__":
    unittest.main()
