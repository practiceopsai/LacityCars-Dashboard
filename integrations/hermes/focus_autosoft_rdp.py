"""Bring exactly one expected AutoSoft RDP client to the foreground.

This helper deliberately does not click, type, or paste. It only establishes
and verifies the foreground boundary that must exist before Hermes uses visual
computer controls inside the shared AutoSoft desktop.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from ctypes import wintypes


def fail(reason: str, matches: list[dict[str, object]] | None = None) -> int:
    print(json.dumps({"ok": False, "reason": reason, "matches": matches or []}))
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-title", required=True)
    args = parser.parse_args()
    if os.name != "nt":
        return fail("WINDOWS_REQUIRED")

    expected = args.expected_title.strip().casefold()
    aliases = {expected}
    if expected.endswith(" cars"):
        aliases.add(expected[: -len(" cars")].strip())
    aliases = {alias for alias in aliases if len(alias) >= 4}
    if not aliases:
        return fail("EXPECTED_TITLE_TOO_SHORT")

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    windows: list[dict[str, object]] = []
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @enum_proc
    def visit(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        title_len = user32.GetWindowTextLengthW(hwnd)
        if title_len <= 0:
            return True
        title_buf = ctypes.create_unicode_buffer(title_len + 1)
        user32.GetWindowTextW(hwnd, title_buf, len(title_buf))
        class_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_buf, len(class_buf))
        title = title_buf.value
        if class_buf.value != "TscShellContainerClass":
            return True
        if any(alias in title.casefold() for alias in aliases):
            windows.append({"hwnd": int(hwnd), "title": title, "class": class_buf.value})
        return True

    user32.EnumWindows(visit, 0)
    if len(windows) != 1:
        return fail("EXPECTED_ONE_MATCHING_RDP_WINDOW", windows)

    hwnd = int(windows[0]["hwnd"])
    foreground = user32.GetForegroundWindow()
    current_thread = kernel32.GetCurrentThreadId()
    foreground_thread = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
    target_thread = user32.GetWindowThreadProcessId(hwnd, None)
    attached_foreground = False
    attached_target = False
    try:
        if foreground_thread and foreground_thread != current_thread:
            attached_foreground = bool(user32.AttachThreadInput(current_thread, foreground_thread, True))
        if target_thread and target_thread != current_thread:
            attached_target = bool(user32.AttachThreadInput(current_thread, target_thread, True))
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.SetActiveWindow(hwnd)
    finally:
        if attached_target:
            user32.AttachThreadInput(current_thread, target_thread, False)
        if attached_foreground:
            user32.AttachThreadInput(current_thread, foreground_thread, False)

    actual = user32.GetForegroundWindow()
    if actual != hwnd:
        return fail("FOREGROUND_VERIFICATION_FAILED", windows)
    print(json.dumps({"ok": True, "hwnd": hwnd, "title": windows[0]["title"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
