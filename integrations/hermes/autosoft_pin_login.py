#!/usr/bin/env python3
"""Submit the configured AutoSoft Accounting PIN without exposing it to Hermes.

The PIN lives in Windows Credential Manager.  This helper only succeeds when
the expected AutoSoft RDP window is foreground, permits one attempt per
dashboard request ID, and never prints or writes the credential value.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import sys
from ctypes import wintypes
from pathlib import Path


CREDENTIAL_TARGET = "VehicleStocking/AutoSoftAccountingPIN"
CRED_TYPE_GENERIC = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
INPUT_KEYBOARD = 1
VK_RETURN = 0x0D
REQUEST_RE = re.compile(r"^[A-Za-z0-9:_-]{8,240}$")
PIN_RE = re.compile(r"^\d{4}$")


class CREDENTIALW(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class INPUTUNION(ctypes.Union):
    # INPUT is a tagged union. Even though this helper only sends keyboard
    # events, the union must include its largest Windows member so ctypes uses
    # the native INPUT size (40 bytes on 64-bit Windows). A keyboard-only union
    # is smaller and causes SendInput to reject the entire array with
    # ERROR_INVALID_PARAMETER.
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("union",)
    _fields_ = [("type", wintypes.DWORD), ("union", INPUTUNION)]


def read_credential(target: str = CREDENTIAL_TARGET) -> str:
    if os.name != "nt":
        raise RuntimeError("AutoSoft PIN injection is supported only on Windows")
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi32.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(CREDENTIALW))]
    advapi32.CredReadW.restype = wintypes.BOOL
    advapi32.CredFree.argtypes = [ctypes.c_void_p]
    pointer = ctypes.POINTER(CREDENTIALW)()
    if not advapi32.CredReadW(target, CRED_TYPE_GENERIC, 0, ctypes.byref(pointer)):
        raise RuntimeError("configured AutoSoft Accounting PIN credential is unavailable")
    try:
        credential = pointer.contents
        blob = ctypes.string_at(credential.CredentialBlob, credential.CredentialBlobSize)
        try:
            value = blob.decode("utf-16-le").rstrip("\x00")
        except UnicodeDecodeError:
            value = blob.decode("utf-8").rstrip("\x00")
    finally:
        advapi32.CredFree(pointer)
    if not PIN_RE.fullmatch(value):
        raise RuntimeError("configured AutoSoft Accounting PIN credential has an invalid format")
    return value


def foreground_rdp_title(expected_title: str) -> str:
    if os.name != "nt":
        raise RuntimeError("foreground validation is supported only on Windows")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        raise RuntimeError("no foreground window is available")
    length = user32.GetWindowTextLengthW(hwnd)
    title_buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
    title = title_buffer.value
    process_id = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, process_id.value)
    executable = ""
    if process:
        try:
            size = wintypes.DWORD(32768)
            executable_buffer = ctypes.create_unicode_buffer(size.value)
            if kernel32.QueryFullProcessImageNameW(process, 0, executable_buffer, ctypes.byref(size)):
                executable = Path(executable_buffer.value).name.lower()
        finally:
            kernel32.CloseHandle(process)
    if executable != "mstsc.exe":
        raise RuntimeError("foreground window is not Remote Desktop")
    if expected_title.lower() not in title.lower():
        raise RuntimeError("foreground Remote Desktop title does not match the authorized store")
    return title


def claim_attempt(request_id: str, root: Path) -> Path:
    if not REQUEST_RE.fullmatch(request_id):
        raise RuntimeError("invalid dashboard request ID")
    root.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(request_id.encode("utf-8")).hexdigest()
    path = root / f"{digest}.attempted"
    try:
        with path.open("x", encoding="ascii") as handle:
            handle.write("attempted\n")
    except FileExistsError as exc:
        raise RuntimeError("Accounting PIN was already attempted for this dashboard request") from exc
    return path


def keyboard_input(*, virtual_key: int = 0, scan_code: int = 0, flags: int = 0) -> INPUT:
    return INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(virtual_key, scan_code, flags, 0, None))


def send_secret(pin: str) -> None:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    user32.SendInput.restype = wintypes.UINT
    inputs: list[INPUT] = []
    for char in pin:
        inputs.append(keyboard_input(scan_code=ord(char), flags=KEYEVENTF_UNICODE))
        inputs.append(keyboard_input(scan_code=ord(char), flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    inputs.append(keyboard_input(virtual_key=VK_RETURN))
    inputs.append(keyboard_input(virtual_key=VK_RETURN, flags=KEYEVENTF_KEYUP))
    array = (INPUT * len(inputs))(*inputs)
    ctypes.set_last_error(0)
    sent = user32.SendInput(len(array), array, ctypes.sizeof(INPUT))
    if sent != len(array):
        error_code = ctypes.get_last_error()
        raise RuntimeError(
            "Windows did not accept the complete secure PIN input sequence "
            f"(sent {sent} of {len(array)} inputs; Win32 error {error_code})"
        )


def execute(args: argparse.Namespace) -> dict[str, object]:
    foreground_rdp_title(args.expected_title)
    pin = read_credential()
    claim_attempt(args.request_id, args.attempt_root)
    send_secret(pin)
    return {"ok": True, "submitted": True, "verification_required": True}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-title", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument(
        "--attempt-root",
        type=Path,
        default=Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "VehicleStocking" / "pin-attempts",
    )
    return parser.parse_args()


def main() -> int:
    try:
        result = execute(parse_args())
        print(json.dumps(result))
        return 0
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"secure AutoSoft PIN submission failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
