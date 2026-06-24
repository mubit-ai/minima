from __future__ import annotations

import shutil
import subprocess

from minima_harness.tui.customize import GLOBAL_DIR, PACKAGES_DIR  # noqa: F401


def _slug(source: str) -> str:
    """git:github.com/user/repo[.git] | https://.../repo.git → repo"""
    url = source.split("git:", 1)[1] if source.startswith("git:") else source
    return url.rstrip("/").split("/")[-1].removesuffix(".git")


def install(source: str) -> int:
    PACKAGES_DIR.mkdir(parents=True, exist_ok=True)
    url = source.split("git:", 1)[1] if source.startswith("git:") else source
    slug = _slug(source)
    dest = PACKAGES_DIR / slug
    if dest.exists():
        print(f"{slug}: already installed")
        return 0
    try:
        subprocess.run(["git", "clone", "--depth", "1", url, str(dest)], check=True)  # noqa: S603,S607
    except Exception as exc:  # noqa: BLE001
        print(f"install failed: {exc}")
        return 1
    print(f"installed {slug} → {dest}")
    return 0


def list_packages() -> int:
    if not PACKAGES_DIR.is_dir():
        print("(no packages installed)")
        return 0
    names = [d.name for d in sorted(PACKAGES_DIR.iterdir()) if d.is_dir()]
    print("\n".join(names) if names else "(no packages installed)")
    return 0


def remove(name: str) -> int:
    dest = PACKAGES_DIR / name
    if not dest.exists():
        print(f"{name}: not installed")
        return 1
    shutil.rmtree(dest)
    print(f"removed {name}")
    return 0


def packages_cli(cmd: str, args: list[str]) -> int:
    if cmd == "install" and args:
        return install(args[0])
    if cmd == "list":
        return list_packages()
    if cmd == "remove" and args:
        return remove(args[0])
    print("usage: minima install <git-url|repo> | list | remove <name>")
    return 2
