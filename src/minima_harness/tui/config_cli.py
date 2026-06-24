"""``minima-harness config`` — the pre-TUI credential setup command.

Sectioned guided setup plus non-interactive ``list``/``get``/``set``/``unset``/``doctor``/
``path``. Secrets are never echoed: interactive entry uses ``getpass``, and ``list``/``get``
mask values to the last 4 characters. Backed by :mod:`minima_harness.tui.config_store`.
"""

from __future__ import annotations

import getpass
import os
import sys

from minima_harness.tui import config_store as store

_USAGE = (
    "usage: minima-harness config "
    "[list | get <KEY> | set <KEY> <VALUE> | unset <KEY> | doctor | path]\n"
    "       minima-harness config            # interactive guided setup"
)


def _list() -> int:
    print(f"config file:     {store.CONFIG_FILE}")
    print(f"secrets backend: {store.backend_name()} (service '{store.KEYRING_SERVICE}')\n")
    for section in store.SECTIONS:
        print(f"[{section.title}]")
        for f in section.fields:
            val = store.get(f.key)
            if val:
                shown = store.mask(val) if f.secret else val
                print(f"  {f.key:<20} {shown:<26} ({store.location(f.key)})")
            else:
                print(f"  {f.key:<20} {'—':<26} ({'optional' if f.optional else 'MISSING'})")
        print()
    return 0


def _interactive() -> int:
    print("minima-harness config — press Enter to keep the current value.\n")
    for section in store.SECTIONS:
        print(f"# {section.title} — {section.note}")
        for f in section.fields:
            cur = store.get(f.key)
            if f.secret:
                shown = store.mask(cur) if cur else "unset"
                entered = getpass.getpass(f"  {f.key} [{shown}]: ").strip()
            else:
                shown = cur or f.default or "unset"
                entered = input(f"  {f.key} [{shown}]: ").strip()
            if entered:
                print(f"    saved → {store.set_value(f.key, entered)}")
            elif not cur and f.default and not f.secret:
                store.set_value(f.key, f.default)
                print(f"    saved default → {f.default}")
        print()
    print("done. Run `minima-harness config doctor` to verify.")
    return 0


def _doctor() -> int:
    store.hydrate_env()
    print("config doctor\n")
    providers = [
        ("Anthropic", "ANTHROPIC_API_KEY"),
        ("Gemini", "GEMINI_API_KEY"),
        ("OpenAI", "OPENAI_API_KEY"),
        ("Mubit", "MUBIT_API_KEY"),
    ]
    for label, key in providers:
        ok = bool(os.environ.get(key))
        print(f"  [{'ok' if ok else '  '}] {label:<10} {key:<18} {'present' if ok else 'missing'}")

    url = os.environ.get("MINIMA_URL", "https://api.minima.sh")
    print(f"\n  Minima endpoint: {url}")
    try:
        import httpx

        resp = httpx.get(url.rstrip("/") + "/v1/health", timeout=5.0)
        print(f"  health: HTTP {resp.status_code}")
    except Exception as exc:  # noqa: BLE001 - any failure is just 'unreachable'
        print(f"  health: unreachable ({type(exc).__name__})")
    return 0


def config_cli(args: list[str]) -> int:
    if not args:
        return _interactive()
    cmd, rest = args[0], args[1:]
    if cmd == "list":
        return _list()
    if cmd == "path":
        print(store.CONFIG_FILE)
        print(f"secrets backend: {store.backend_name()} (service '{store.KEYRING_SERVICE}')")
        return 0
    if cmd == "doctor":
        return _doctor()
    if cmd == "get" and rest:
        val = store.get(rest[0])
        if val is None:
            print(f"{rest[0]}: unset", file=sys.stderr)
            return 1
        f = store.field_for(rest[0])
        print(store.mask(val) if (f is None or f.secret) else val)  # secrets stay masked
        return 0
    if cmd == "set" and len(rest) >= 2:
        print(f"set {rest[0]} → {store.set_value(rest[0], rest[1])}")
        return 0
    if cmd == "unset" and rest:
        store.unset(rest[0])
        print(f"unset {rest[0]}")
        return 0
    print(_USAGE, file=sys.stderr)
    return 2
