#!/usr/bin/env python3
"""Regenerate a Homebrew formula's `resource` blocks to install PREBUILT WHEELS instead of
sdists — so `brew install minima` stops compiling grpcio / cryptography / pydantic-core / jiter
from source on every user's machine (the ~5-minute cost).

Strategy:
  * pure-Python deps      -> the universal ``*-none-any.whl`` (one url, all platforms);
  * compiled deps         -> per-arch cp313 wheels (macOS arm64/x86_64, Linux x86_64/aarch64)
                             emitted in on_macos/on_linux + on_arm/on_intel blocks;
  * a dep with no wheel for some platform falls back to its sdist *in that branch only*, and the
    formula keeps ``depends_on "rust"`` / ``"openssl@3"`` scoped to the platforms that still build.

Versions are taken from the EXISTING formula (so we regenerate the exact locked closure), and a
package that isn't on PyPI (e.g. a private sdk) is emitted unchanged.

Usage:
    python packaging/homebrew/gen_resources.py <formula.rb>          # print regenerated resources
    python packaging/homebrew/gen_resources.py <formula.rb> --check  # just verify wheel coverage
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field

import httpx

_PY = "cp313"
_PY_MINOR = 13
_RES_RE = re.compile(
    r'resource\s+"(?P<name>[^"]+)"\s+do.*?url\s+"(?P<url>[^"]+)".*?sha256\s+"(?P<sha>[0-9a-f]+)"',
    re.DOTALL,
)
_VER_RE = re.compile(r"/(?:[^/]+?)-(?P<ver>\d[^/]*?)(?:\.tar\.gz|-py\d|\.whl)")


@dataclass
class Existing:
    name: str
    version: str
    url: str
    sha: str


@dataclass
class Wheels:
    """Resolved wheel (url, sha) per platform key; None where no compatible wheel exists."""

    pure: tuple[str, str] | None = None  # universal *-none-any.whl
    by_plat: dict[str, tuple[str, str]] = field(default_factory=dict)  # plat -> (url, sha)


_ALL_PLATFORMS = ("macos_arm", "macos_intel", "linux_arm", "linux_intel")


def parse_existing(text: str) -> list[Existing]:
    out: list[Existing] = []
    for m in _RES_RE.finditer(text):
        url = m["url"]
        vm = _VER_RE.search(url)
        out.append(Existing(m["name"], vm["ver"] if vm else "", url, m["sha"]))
    return out


def _cp313_compatible(fn: str) -> bool:
    """Is this wheel installable under cp313? cp313-cp313, cp313-abi3, or an older cpXX-abi3
    (stable ABI is forward-compatible)."""
    if f"-{_PY}-{_PY}-" in fn or f"-{_PY}-abi3-" in fn:
        return True
    m = re.search(r"-cp3(\d+)-abi3-", fn)
    return bool(m and int(m.group(1)) <= _PY_MINOR)


def _platforms_of(fn: str) -> list[str]:
    """Which platform keys a wheel satisfies (a universal2 macOS wheel covers BOTH Mac arches).
    Linux is glibc-only (manylinux) since Homebrew on Linux uses glibc, not musl."""
    stem = fn[:-4]  # drop .whl
    if "macosx" in fn and "universal2" in fn:
        return ["macos_arm", "macos_intel"]
    keys: list[str] = []
    if "macosx" in fn and stem.endswith("arm64"):
        keys.append("macos_arm")
    if "macosx" in fn and stem.endswith("x86_64"):
        keys.append("macos_intel")
    if "manylinux" in fn and stem.endswith("aarch64"):
        keys.append("linux_arm")
    if "manylinux" in fn and stem.endswith("x86_64"):
        keys.append("linux_intel")
    return keys


def resolve_wheels(name: str, version: str) -> Wheels:
    r = httpx.get(f"https://pypi.org/pypi/{name}/{version}/json", timeout=30)
    r.raise_for_status()
    files = [f for f in r.json().get("urls", []) if f.get("packagetype") == "bdist_wheel"]
    w = Wheels()
    for f in files:
        fn = f["filename"]
        if fn.endswith("-none-any.whl") and ("py3" in fn or "py2.py3" in fn):
            w.pure = (f["url"], f["digests"]["sha256"])
            continue
        if not _cp313_compatible(fn):
            continue
        for plat in _platforms_of(fn):
            w.by_plat.setdefault(plat, (f["url"], f["digests"]["sha256"]))
    return w


def _block(url: str, sha: str, indent: str) -> str:
    return f'{indent}url "{url}"\n{indent}sha256 "{sha}"'


def emit(e: Existing, w: Wheels) -> tuple[str, set[str]]:
    """Return (ruby resource block, set of platforms that fell back to sdist)."""
    fallbacks: set[str] = set()
    if w.pure:  # pure-Python: one universal wheel everywhere
        body = _block(*w.pure, "    ")
        return f'  resource "{e.name}" do  # wheel (pure)\n{body}\n  end', fallbacks

    if not w.by_plat:  # not on PyPI / no wheels at all -> keep original (sdist) verbatim
        body = _block(e.url, e.sha, "    ")
        return f'  resource "{e.name}" do  # sdist (no wheel)\n{body}\n  end', {"all"}

    def per(plat: str) -> str:
        if plat in w.by_plat:
            return _block(*w.by_plat[plat], "        ")
        fallbacks.add(plat)
        return _block(e.url, e.sha, "        ")  # build from sdist on this platform

    block = (
        f'  resource "{e.name}" do  # wheel (compiled)\n'
        f"    on_arm do\n"
        f"      on_macos do\n{per('macos_arm')}\n      end\n"
        f"      on_linux do\n{per('linux_arm')}\n      end\n"
        f"    end\n"
        f"    on_intel do\n"
        f"      on_macos do\n{per('macos_intel')}\n      end\n"
        f"      on_linux do\n{per('linux_intel')}\n      end\n"
        f"    end\n"
        f"  end"
    )
    return block, fallbacks


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    path, check = argv[0], "--check" in argv
    text = open(path).read()
    existing = parse_existing(text)
    blocks, all_fallbacks, summary = [], set(), []
    for e in existing:
        try:
            w = resolve_wheels(e.name, e.version)
        except Exception as exc:  # noqa: BLE001
            print(f"# WARN {e.name} {e.version}: {exc}", file=sys.stderr)
            w = Wheels()
        block, fb = emit(e, w)
        blocks.append(block)
        all_fallbacks |= {f"{e.name}:{p}" for p in fb}
        kind = "pure" if w.pure else ("compiled" if w.by_plat else "SDIST-FALLBACK")
        tail = f"  fb={sorted(fb)}" if fb else ""
        summary.append(f"  {e.name:22} {e.version:14} {kind}{tail}")
    print("\n".join(summary), file=sys.stderr)
    n_fb = sum("SDIST" in s for s in summary)
    print(
        f"\n# {len(existing)} resources · {n_fb} sdist-fallback · "
        f"fallbacks={sorted(all_fallbacks)}",
        file=sys.stderr,
    )
    if not check:
        print("\n".join(blocks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
