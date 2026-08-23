"""Make Hermes' configured Windows loop-watchdog opt-out reliable.

Some Hermes builds create ``GatewayRunner.config`` as a mapping during the
Windows service path. The upstream guard only uses ``getattr`` and therefore
falls back to ``True`` even when config.yaml contains
``gateway.loop_watchdog: false``. On the one-core Orgo desktop that kills a
healthy run while model initialization temporarily occupies the event loop.

This patch is intentionally narrow and idempotent. It adds an explicit service
environment opt-out without changing the default behavior for other installs.
"""

from __future__ import annotations

import argparse
from pathlib import Path


OLD = '''        config = getattr(self, "config", None)\n        if config is not None and not getattr(config, "loop_watchdog", True):\n            return\n'''
NEW = '''        config = getattr(self, "config", None)\n        disabled_by_service = os.getenv(\n            "HERMES_DISABLE_LOOP_WATCHDOG", ""\n        ).strip().lower() in {"1", "true", "yes", "on"}\n        disabled_by_mapping = (\n            isinstance(config, dict) and config.get("loop_watchdog") is False\n        )\n        if (\n            disabled_by_service\n            or disabled_by_mapping\n            or (config is not None and not getattr(config, "loop_watchdog", True))\n        ):\n            return\n'''


def patch(agent_root: Path) -> dict[str, object]:
    target = agent_root / "gateway" / "run.py"
    text = target.read_text(encoding="utf-8")
    if NEW in text:
        return {"patched": False, "already_current": True, "target": str(target)}
    if OLD not in text:
        raise RuntimeError("Hermes watchdog guard did not match the reviewed source")
    backup = target.with_suffix(".py.pre-lacity-watchdog")
    if not backup.exists():
        backup.write_text(text, encoding="utf-8")
    target.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    return {"patched": True, "already_current": False, "target": str(target)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-root", type=Path, required=True)
    args = parser.parse_args()
    print(patch(args.agent_root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
