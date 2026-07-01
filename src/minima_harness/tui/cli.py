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
    # Per-user store (OS keyring + ~/.minima-harness/config.env) — lowest precedence, so the
    # CLI works from any directory while shell env and project .env files still override it.
    try:
        from minima_harness.tui.config_store import hydrate_env

        hydrate_env()
    except Exception:  # noqa: BLE001 - config must never block startup
        pass


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="minima", description="Minima CLI — cost-aware model-routing coding agent."
    )
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
        "--mouse",
        action=argparse.BooleanOptionalAction,
        default=None,  # resolved per-terminal below (see _resolve_mouse)
        help="capture the mouse: scroll-wheel + in-app drag-select & copy. Default ON, except "
        "macOS Terminal.app — it doesn't report mouse motion (xterm 1003), so in-app drag-select "
        "can't work and capture would only block its native selection; defaults OFF there (select "
        "natively, scroll with PageUp/PageDown). Override with --mouse/--no-mouse; /mouse toggles.",
    )
    p.add_argument(
        "--dangerously-skip-permissions",
        action="store_true",
        help="don't ask before write/edit/bash (YOLO). Off by default — the TUI asks first.",
    )
    return p


def _resolve_mouse(flag: bool | None) -> bool:
    """Resolve the mouse-capture default. Explicit --mouse/--no-mouse wins. Otherwise ON,
    except macOS Terminal.app, which doesn't report mouse motion (xterm mode 1003) — so in-app
    drag-select can't work there and capturing the mouse would only suppress its rock-solid native
    selection. Default OFF there so users can select+copy out of the box."""
    if flag is not None:
        return flag
    return os.environ.get("TERM_PROGRAM") != "Apple_Terminal"


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
    from minima_harness.ai.provider_catalog import provider_key_present, register_catalog_models
    from minima_harness.ai.providers import ensure_providers_registered
    from minima_harness.tui.extra_models import register_extra_models

    ensure_providers_registered()
    # Register the curated multi-provider catalog, but only for providers whose key is
    # configured — so the model picker stays relevant (you see models you can actually run).
    register_catalog_models()
    # OpenRouter is an aggregator: one key unlocks its *entire* live model list (cached +
    # offline-safe), not just a few curated ids. Register it when the key is present.
    if provider_key_present("openrouter"):
        try:
            from minima_harness.ai.openrouter_catalog import register_openrouter_models

            register_openrouter_models()
        except Exception:  # noqa: BLE001 - never block startup on the OpenRouter catalog
            pass
    register_extra_models(cwd)


def _overlay_minima_prices(config: HarnessConfig) -> None:
    """Best-effort: overlay Minima's authoritative live pricing onto the registered models.

    So the cost the harness reports for a call matches the cost the server routed against
    (keeps est-vs-actual honest). Offline-safe and quick: skipped without a Minima URL, short
    timeout, and any failure is swallowed (the seeded prices stand)."""
    if not (config.minima_url or "").strip():
        return
    try:
        from minima_client import MinimaClient

        from minima_harness.minima.mapping import sync_catalog

        with MinimaClient(
            config.minima_url, config.minima_api_key, timeout=min(config.timeout, 8.0)
        ) as client:
            sync_catalog(client)
    except Exception:  # noqa: BLE001 - pricing overlay must never block startup
        pass


def main(argv: list[str] | None = None) -> int:
    _load_env_files()
    raw = sys.argv[1:] if argv is None else list(argv)

    # `minima-harness config …` — credential setup (no TUI; works before any keys exist).
    if raw and raw[0] == "config":
        from minima_harness.tui.config_cli import config_cli

        return config_cli(raw[1:])

    # `minima-harness install|list|remove …` — package management (no TUI).
    if raw and raw[0] in _PKG_COMMANDS:
        return packages_cli(raw[0], raw[1:])

    args = _build_parser().parse_args(raw)
    config = HarnessConfig.from_env()
    if args.offline:
        config.minima_url = ""
    cwd = Path.cwd()
    _register_providers(cwd)
    # Gate the routing candidate pool to models whose provider key is configured (after
    # registration so newly-added providers count) — Minima won't be offered a model the
    # user can't run. No-op when keys for the defaults (Anthropic/Gemini) are present.
    from minima_harness.ai.provider_catalog import runnable_candidates

    config.candidates = runnable_candidates(config.candidates)
    _overlay_minima_prices(config)
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
        # Wire Mubit memory (recall-before-route + outcome write-back) for the one-shot run.
        from minima_harness.tui.mubit import init_mubit

        if init_mubit(cwd):
            from uuid import uuid4

            from minima_harness.minima.memory import MubitHarnessMemory

            agent.memory = MubitHarnessMemory(session_id=uuid4().hex)
        from minima_harness.tui.run_modes import run_json, run_print

        runner = run_json if args.mode == "json" else run_print

        async def _run_once() -> int:
            try:
                return await runner(agent, prompt)
            finally:
                # Distil the one-shot run into durable memory (reflect + checkpoint).
                await agent.end_session()

        return asyncio.run(_run_once())

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
        skip_permissions=args.dangerously_skip_permissions,
        mouse=(mouse := _resolve_mouse(args.mouse)),
    )
    app.run(mouse=mouse)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
