"""``minima-route`` — a tiny CLI so ANY harness (Claude Code included) can consume
Minima's loop from shell seams.

Pick a model for a task (prints the bare model id, or full JSON with ``--json``)::

    model=$(minima-route recommend "refactor the auth module" \
        --candidates claude-haiku-4-5,claude-sonnet-4-6)
    claude --model "$model" -p "refactor the auth module"

Close the loop after you ran it (realized numbers, never Minima's own estimate)::

    minima-route feedback "$rec_id" "$model" success \
        --cost 0.0042 --input-tokens 1800 --output-tokens 600 --latency-ms 9000 \
        --source human

Connection comes from ``MINIMA_URL`` (default https://api.minima.sh) and
``MINIMA_API_KEY``/``MUBIT_API_KEY``, overridable with ``--url``/``--api-key``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from minima_client.client import MinimaClient, Usage


def _client(args: argparse.Namespace) -> MinimaClient:
    url = args.url or os.environ.get("MINIMA_URL") or "https://api.minima.sh"
    key = args.api_key or os.environ.get("MINIMA_API_KEY") or os.environ.get("MUBIT_API_KEY")
    return MinimaClient(url, api_key=key)


def _cmd_recommend(args: argparse.Namespace) -> int:
    constraints = (
        {"candidate_models": [c.strip() for c in args.candidates.split(",") if c.strip()]}
        if args.candidates
        else None
    )
    with _client(args) as minima:
        rec = minima.recommend(
            args.task,
            cost_quality_tradeoff=args.slider,
            constraints=constraints,
            namespace=args.namespace,
        )
    if args.json:
        print(
            json.dumps(
                {
                    "recommendation_id": rec.recommendation_id,
                    "model_id": rec.recommended_model.model_id,
                    "est_cost_usd": rec.recommended_model.est_cost_usd,
                    "predicted_success": rec.recommended_model.predicted_success,
                    "warnings": rec.warnings,
                }
            )
        )
    else:
        print(rec.recommended_model.model_id)
    return 0


def _cmd_feedback(args: argparse.Namespace) -> int:
    with _client(args) as minima:
        resp = minima.feedback(
            args.recommendation_id,
            args.model,
            args.outcome,
            usage=Usage(
                input_tokens=args.input_tokens,
                output_tokens=args.output_tokens,
                cost_usd=args.cost,
                latency_ms=args.latency_ms,
            ),
            quality_score=args.quality,
            evidence_source=args.source,
        )
    print(json.dumps({"accepted": resp.accepted, "warnings": resp.warnings}))
    return 0 if resp.accepted else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="minima-route", description=__doc__)
    parser.add_argument("--url", default=None)
    parser.add_argument("--api-key", default=None)
    sub = parser.add_subparsers(dest="command", required=True)

    rec = sub.add_parser("recommend", help="print the model Minima recommends for a task")
    rec.add_argument("task")
    rec.add_argument("--candidates", default=None, help="comma-separated model ids")
    rec.add_argument("--slider", type=float, default=None, help="cost/quality 0..10")
    rec.add_argument("--namespace", default=None)
    rec.add_argument("--json", action="store_true", help="full JSON incl. recommendation_id")
    rec.set_defaults(func=_cmd_recommend)

    fb = sub.add_parser("feedback", help="report the realized outcome back")
    fb.add_argument("recommendation_id")
    fb.add_argument("model")
    fb.add_argument("outcome", choices=["success", "partial", "failure"])
    fb.add_argument("--cost", type=float, default=None, help="realized USD (never the estimate)")
    fb.add_argument("--input-tokens", type=int, default=None)
    fb.add_argument("--output-tokens", type=int, default=None)
    fb.add_argument("--latency-ms", type=int, default=None)
    fb.add_argument("--quality", type=float, default=None, help="0..1 if you graded it")
    fb.add_argument(
        "--source",
        default="none",
        choices=["gate", "judge", "human", "none"],
        help=(
            "label provenance; default none = cost telemetry only. Pass --source human "
            "ONLY when a human actually verified this outcome — it counts as a real label."
        ),
    )
    fb.set_defaults(func=_cmd_feedback)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
