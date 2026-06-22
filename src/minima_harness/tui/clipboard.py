from __future__ import annotations

import shutil
import subprocess
import sys


def _clipboard_command() -> list[str] | None:
    if sys.platform == "darwin":
        return ["pbcopy"]
    if shutil.which("wl-copy"):
        return ["wl-copy"]
    if shutil.which("xclip"):
        return ["xclip", "-selection", "clipboard"]
    if shutil.which("xsel"):
        return ["xsel", "--clipboard", "--input"]
    if sys.platform == "win32":
        return ["clip"]
    return None


def copy_to_clipboard(text: str) -> bool:
    """Copy ``text`` to the system clipboard. Returns True on success.

    Full-screen TUI apps capture the mouse, so native terminal selection/copy usually
    fails; this routes through the platform clipboard tool (pbcopy/xclip/xsel/wl-copy/clip).
    """
    cmd = _clipboard_command()
    if not cmd:
        return False
    try:
        subprocess.run(cmd, input=text.encode("utf-8"), check=True)  # noqa: S603
    except Exception:  # noqa: BLE001
        return False
    return True
