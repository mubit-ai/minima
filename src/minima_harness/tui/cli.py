from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from minima_harness.minima.config import HarnessConfig
from minima_harness.session import SessionManager
from minima_harness.tui.app import HarnessApp

# .env files (in cwd) auto-loaded so `minima-harness` works without `make`/`--env-file`.
_ENV_FILES = (".env.harness", ".env")


def _load_env_files() -> None:
    for name in _ENV_FILES:
        path = Path(name)
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            val = val.strip().strip('"').strip("'")
            os.environ.setdefault(key.strip(), val)  # real env / --env-file wins


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="minima-harness", description="PI-style agent on Minima.")
    p.add_argument("prompt", nargs="*", help="optional initial prompt")
    p.add_argument("--provider")
    p.add_argument("--model")
    p.add_argument("--thinking", default="off")
    p.add_argument("-c", "--continue", dest="continue_last", action="store_true")
    p.add_argument("-r", "--resume", action="store_true")
    p.add_argument("--session")
    p.add_argument("--fork")
    p.add_argument("--no-session", action="store_true")
    p.add_argument("-n", "--name")
    p.add_argument("-t", "--tools", help="comma-separated allowlist")
    p.add_argument("-xt", "--exclude-tools", help="comma-separated denylist")
    p.add_argument("-nt", "--no-tools", action="store_true")
    p.add_argument("--offline", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    _load_env_files()
    args = _build_parser().parse_args(argv)
    config = HarnessConfig.from_env()
    if args.offline:
        config.minima_url = ""
    cwd = Path.cwd()
    mgr = SessionManager()
    try:
        session = mgr.open(cwd, session_id=args.session, no_session=args.no_session)
        if args.name:
            session.display_name = args.name
    except FileNotFoundError as exc:
        print(f"minima-harness: {exc}", file=sys.stderr)
        return 2

    from minima_harness.tools import default_toolset

    tools = [] if args.no_tools else default_toolset()
    if args.tools:
        allow = {t.strip() for t in args.tools.split(",")}
        tools = [t for t in tools if t.name in allow]
    if args.exclude_tools:
        deny = {t.strip() for t in args.exclude_tools.split(",")}
        tools = [t for t in tools if t.name not in deny]

    app = HarnessApp(config, session=session, tools=tools, cwd=cwd)
    app.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
