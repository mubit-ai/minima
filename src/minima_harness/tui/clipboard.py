from __future__ import annotations

import base64
import shutil
import subprocess
import sys


def _platform_command() -> list[str] | None:
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


def _osc52_copy(text: str) -> bool:
    """Emit an OSC 52 clipboard sequence to the controlling terminal.

    Works through tmux/SSH and modern terminals (iTerm2, kitty, wezterm, alacritty,
    Windows Terminal). Best-effort: harmless if the terminal ignores it.
    """
    if sys.platform == "win32":
        return False
    seq = f"\x1b]52;c;{base64.b64encode(text.encode('utf-8')).decode('ascii')}\x07"
    for target in ("/dev/tty",):  # write straight to the controlling terminal
        try:
            with open(target, "w", encoding="utf-8") as tty:
                tty.write(seq)
                tty.flush()
            return True
        except OSError:
            continue
    return False


def copy_to_clipboard(text: str) -> bool:
    """Copy ``text`` to the clipboard. Returns True if any method wrote without error.

    Full-screen TUI apps capture the mouse, so native selection/copy usually fails.
    Tries the platform clipboard tool (pbcopy/xclip/xsel/wl-copy/clip) AND OSC 52 (which
    reaches the clipboard even through tmux/SSH).
    """
    ok = False
    cmd = _platform_command()
    if cmd is not None:
        try:
            subprocess.run(cmd, input=text.encode("utf-8"), check=True)  # noqa: S603
            ok = True
        except Exception:  # noqa: BLE001
            pass
    if _osc52_copy(text):
        ok = True
    return ok
