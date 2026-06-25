#!/usr/bin/env python3
"""Print Homebrew `resource` blocks (with wheel URLs + sha256) for Minima's compiled deps.

Homebrew's `std_pip_args` forces `--no-binary=:all:`, so the default formula compiles
grpcio/protobuf/cffi/jiter/pydantic-core/cryptography from source — a ~5 min install with a
heavy CPU/RAM spike. The formula instead vendors prebuilt wheels for these and installs them
via a custom `def install` (see Formula/minima.rb in the tap, and packaging/homebrew/README.md).

`brew update-python-resources` regenerates every resource as an sdist, so after running it you
must re-apply the wheels for these six packages. This script fetches the right macOS wheels
(cp313 / abi3 / universal2) for the versions you pass and prints ready-to-paste resource blocks.

Usage:
    # versions default to whatever is in the current tap formula; override as needed:
    python packaging/homebrew/wheel_urls.py \
        grpcio==1.81.1 protobuf==7.35.1 cffi==2.0.0 jiter==0.15.0 \
        pydantic-core==2.46.4 cryptography==49.0.0 websockets==16.0

Notes:
- cryptography publishes no x86_64 macOS wheel; on Intel it must build from source (sdist).
  This script emits its arm64 wheel under `on_arm` and the sdist under `on_intel`.
- grpcio/protobuf ship a single universal2 wheel that covers both arches (no on_arm/on_intel).
- For the others, an `on_arm`/`on_intel` pair is emitted (both arches ship per-arch wheels).
"""

from __future__ import annotations

import json
import sys
import urllib.request

PY = "cp313"  # the formula pins python@3.13

# Packages that ship ONE wheel covering both arches → no on_arm/on_intel split.
UNIVERSAL = {"grpcio", "protobuf", "websockets"}
# Packages with no x86_64 macОS wheel → Intel falls back to the sdist.
ARM_ONLY = {"cryptography"}


def _pypi(name: str, version: str) -> dict:
    url = f"https://pypi.org/pypi/{name}/{version}/json"
    with urllib.request.urlopen(url, timeout=30) as r:  # noqa: S310 (trusted host)
        return json.load(r)


def _pick(files: list[dict], *, arch: str | None, universal: bool) -> dict | None:
    """Pick the best macOS cp313/abi3 wheel for the given arch (or a universal2 wheel)."""
    cands = [f for f in files if f["filename"].endswith(".whl") and "macos" in f["filename"]]
    cands = [f for f in cands if PY in f["filename"] or "abi3" in f["filename"]]
    if universal:
        u = [f for f in cands if "universal2" in f["filename"]]
        return u[0] if u else None
    return next((f for f in cands if arch in f["filename"]), None)


def _sdist(data: dict) -> dict | None:
    return next((u for u in data["urls"] if u["packagetype"] == "sdist"), None)


def block(spec: str) -> str:
    name, _, version = spec.partition("==")
    if not version:
        sys.exit(f"missing version: expected NAME==VERSION, got {spec!r}")
    data = _pypi(name, version)
    files = data["urls"]

    def res(file: dict, indent: int, comment: str = "") -> str:
        pad = " " * indent
        tail = f"  # {comment}" if comment else ""
        return f'{pad}url "{file["url"]}"{tail}\n{pad}sha256 "{file["digests"]["sha256"]}"'

    if name in UNIVERSAL:
        w = _pick(files, arch=None, universal=True)
        if not w:
            sys.exit(f"{name} {version}: no universal2 wheel found")
        return (
            f'  resource "{name}" do  # wheel (universal2) — installed via `def install`\n'
            f"{res(w, 4)}\n  end"
        )

    arm = _pick(files, arch="arm64", universal=False)
    if not arm:
        sys.exit(f"{name} {version}: no arm64 macOS wheel found")

    if name in ARM_ONLY:
        sd = _sdist(data)
        if not sd:
            sys.exit(f"{name} {version}: no sdist for the Intel fallback")
        return (
            f'  resource "{name}" do\n'
            f"    on_arm do  # wheel — installed via `def install`\n{res(arm, 6)}\n    end\n"
            f"    on_intel do  # no x86_64 wheel → built from source (needs rust + openssl@3)\n"
            f"{res(sd, 6)}\n    end\n"
            f"  end"
        )

    intel = _pick(files, arch="x86_64", universal=False)
    if not intel:
        sys.exit(f"{name} {version}: no x86_64 macOS wheel found")
    return (
        f'  resource "{name}" do  # wheel — installed via `def install`\n'
        f"    on_arm do\n{res(arm, 6)}\n    end\n"
        f"    on_intel do\n{res(intel, 6)}\n    end\n"
        f"  end"
    )


def main() -> None:
    specs = sys.argv[1:]
    if not specs:
        sys.exit(__doc__)
    print("\n".join(block(s) for s in specs))


if __name__ == "__main__":
    main()
