"""Verify installed packages against their wheel RECORD hashes.

A hand-patched file in site-packages lets the whole test suite vouch for code that no
released package contains (this is exactly how the mubit-sdk `Client.lookup` prod
incident stayed invisible locally). This walks every installed distribution, re-hashes
each file RECORD claims, and fails loudly on any mismatch.

Usage: uv run python scripts/verify_venv_integrity.py [dist-name ...]
With no args, every installed distribution is checked.
"""

from __future__ import annotations

import base64
import hashlib
import sys
from importlib.metadata import distributions


def _file_hash(path: str, algo: str) -> str:
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return base64.urlsafe_b64encode(h.digest()).rstrip(b"=").decode("ascii")


def main(argv: list[str]) -> int:
    only = {name.lower() for name in argv}
    mismatched: list[str] = []
    missing: list[str] = []
    dists = 0
    files = 0
    for dist in distributions():
        name = (dist.metadata["Name"] or "").lower()
        if only and name not in only:
            continue
        if not dist.files:
            continue
        dists += 1
        for pf in dist.files:
            hash_ = getattr(pf, "hash", None)
            if hash_ is None:
                continue  # RECORD itself, *.pyc, editable .pth stubs
            try:
                located = dist.locate_file(pf)
            except Exception:
                continue
            path = str(located)
            try:
                actual = _file_hash(path, hash_.mode.replace("-", "_"))
            except FileNotFoundError:
                missing.append(f"{name}: {pf}")
                continue
            except ValueError:
                continue  # unknown hash algo — nothing to verify against
            files += 1
            if actual != hash_.value:
                mismatched.append(f"{name}: {pf}")
    for line in mismatched:
        print(f"TAMPERED (hash != wheel RECORD): {line}", file=sys.stderr)
    for line in missing:
        print(f"MISSING (listed in RECORD, not on disk): {line}", file=sys.stderr)
    if mismatched:
        print(
            f"venv integrity FAILED: {len(mismatched)} tampered file(s) across {dists} dist(s). "
            "Reinstall with `uv sync --reinstall` — never hand-patch site-packages.",
            file=sys.stderr,
        )
        return 1
    print(f"venv integrity OK: {files} files across {dists} dists match their wheel RECORD")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
