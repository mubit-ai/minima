#!/usr/bin/env python3
"""Render the Homebrew formula for the prebuilt Bun binary.

The TypeScript harness compiles to a single self-contained binary per platform
(see packages/tui/scripts/build-all.ts), attached to each GitHub release as
``minima-<version>-<os>-<arch>.tar.gz``. This emits a ~30-line binary formula
(per-platform url + sha256 + ``bin.install "minima"``) — replacing the old
~50-wheel Python-virtualenv formula and its generator (gen_resources.py).

sha256 values are computed from the actual tarballs in --dist, so the formula
always matches the bytes that were uploaded.

Usage:
    python packaging/homebrew/render_formula.py --version 0.5.0 --dist dist [--out Formula/minima.rb]
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

REPO = "mubit-ai/minima"
# Homebrew platform block -> release-asset platform slug.
PLATFORMS = [
    ("on_macos", "on_arm", "darwin-arm64"),
    ("on_macos", "on_intel", "darwin-x64"),
    ("on_linux", "on_arm", "linux-arm64"),
    ("on_linux", "on_intel", "linux-x64"),
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def render(version: str, dist: Path, repo: str) -> str:
    def block(os_key: str, arch_key: str, slug: str) -> tuple[str, str]:
        tarball = dist / f"minima-{version}-{slug}.tar.gz"
        if not tarball.exists():
            sys.exit(f"missing release tarball: {tarball}")
        url = f"https://github.com/{repo}/releases/download/v{version}/{tarball.name}"
        return url, sha256(tarball)

    by_os: dict[str, list[str]] = {"on_macos": [], "on_linux": []}
    for os_key, arch_key, slug in PLATFORMS:
        url, sha = block(os_key, arch_key, slug)
        by_os[os_key].append(
            f"    {arch_key} do\n      url \"{url}\"\n      sha256 \"{sha}\"\n    end"
        )

    macos = "\n".join(by_os["on_macos"])
    linux = "\n".join(by_os["on_linux"])
    return f"""\
class Minima < Formula
  desc "Cost-aware LLM model-routing coding agent"
  homepage "https://docs.minima.sh"
  version "{version}"
  license :cannot_represent # FSL-1.1-Apache-2.0 (not an SPDX id)

  # Prebuilt, self-contained Bun binary — no Python, no runtime deps. Install is
  # a download + extract (seconds), not a ~5-minute virtualenv build.
  on_macos do
{macos}
  end

  on_linux do
{linux}
  end

  def install
    bin.install "minima"
  end

  test do
    assert_match "cost-aware", shell_output("#{{bin}}/minima --help")
  end
end
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True, help="release version, e.g. 0.5.0 (no leading v)")
    ap.add_argument("--dist", default="dist", type=Path, help="dir holding the release tarballs")
    ap.add_argument("--repo", default=REPO, help="GitHub owner/repo for asset URLs")
    ap.add_argument("--out", type=Path, help="write here (default: stdout)")
    args = ap.parse_args()

    version = args.version.lstrip("v")
    formula = render(version, args.dist, args.repo)
    if args.out:
        args.out.write_text(formula)
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(formula)


if __name__ == "__main__":
    main()
