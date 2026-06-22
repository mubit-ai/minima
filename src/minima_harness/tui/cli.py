from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.meter import CostMeter
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionManager, SessionStore
from minima_harness.tui.app import HarnessApp
from minima_harness.tui.context import build_system_prompt
from minima_harness.tui.packages import packages_cli

# .env files (in cwd) auto-loaded so `minima-harness` works without `make`/`--env-file`.
_ENV_FILES = (".env.harness", ".env")
_PKG_COMMANDS = ("install", "list", "remove")


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
    p.add_argument(
        "prompt", nargs="*", help="optional initial prompt (used by --print/--mode json)"
    )
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
    p.add_argument("-p", "--print", action="store_true", help="one-shot: print the reply and exit")
    p.add_argument(
        "--mode",
        choices=("interactive", "print", "json"),
        default="interactive",
        help="run mode (interactive TUI, one-shot print, or JSON event stream)",
    )
    p.add_argument(
        "--no-mouse",
        action="store_true",
        help="disable mouse capture so you can select/copy text (scroll then needs PageUp/Down).",
    )
    return p


def _tools_for(args: argparse.Namespace):
    from minima_harness.tools import default_toolset

    tools = [] if args.no_tools else default_toolset()
    if args.tools:
        allow = {t.strip() for t in args.tools.split(",")}
        tools = [t for t in tools if t.name in allow]
    if args.exclude_tools:
        deny = {t.strip() for t in args.exclude_tools.split(",")}
        tools = [t for t in tools if t.name not in deny]
    return tools


def _register_providers(cwd: Path) -> None:
    from minima_harness.ai.providers import ensure_providers_registered
    from minima_harness.tui.extra_models import register_extra_models

    ensure_providers_registered()
    register_extra_models(cwd)


def main(argv: list[str] | None = None) -> int:
    _load_env_files()
    raw = sys.argv[1:] if argv is None else list(argv)

    # `minima-harness install|list|remove …` — package management (no TUI).
    if raw and raw[0] in _PKG_COMMANDS:
        return packages_cli(raw[0], raw[1:])

    args = _build_parser().parse_args(raw)
    config = HarnessConfig.from_env()
    if args.offline:
        config.minima_url = ""
    cwd = Path.cwd()
    _register_providers(cwd)
    tools = _tools_for(args)

    noninteractive = args.print or args.mode in ("print", "json")
    if noninteractive:
        prompt = " ".join(args.prompt).strip()
        if not prompt:
            print("minima-harness: --print/--mode json requires a prompt", file=sys.stderr)
            return 2
        agent = MinimaAgent(
            config, tools=tools, meter=CostMeter(), system_prompt=build_system_prompt(cwd)
        )
        from minima_harness.tui.run_modes import run_json, run_print

        runner = run_json if args.mode == "json" else run_print
        return asyncio.run(runner(agent, prompt))

    mgr = SessionManager()
    load_on_start = False
    try:
        if args.no_session:
            session = SessionStore.in_memory()
        elif args.session or args.continue_last:
            session = mgr.open(cwd, session_id=args.session)
            load_on_start = True
        else:
            session = mgr.new(cwd, name=args.name)
        if args.name:
            session.display_name = args.name
    except FileNotFoundError as exc:
        print(f"minima-harness: {exc}", file=sys.stderr)
        return 2

    app = HarnessApp(
        config,
        session=session,
        tools=tools,
        cwd=cwd,
        system_prompt=build_system_prompt(cwd),
        load_session=load_on_start,
    )
    app.run(mouse=not args.no_mouse)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
