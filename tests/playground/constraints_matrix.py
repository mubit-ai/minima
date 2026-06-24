"""Phase 4 — constraints matrix fuzzer: which combos eliminate all candidates (422) vs relax.

Sends a stream of /v1/recommend calls, each with a different constraint (singletons) or pair
of constraints (pairwise), and records the outcome:

  no_candidates   HTTP 422 — constraints filtered every model out
  bad_request     HTTP 400 — constraint value rejected (e.g. max_candidates=0)
  relaxed         HTTP 200 but a relaxation warning fired (e.g. no_model_within_cost_budget)
  clean           HTTP 200, ranked normally

Only /recommend is called (no feedback, no LLM — escalation disabled). Output is a table +
an optional JSON dump for diffing. Defaults to a compact run; widen with --mode both.

    set -a; source .env; set +a
    uv run python tests/playground/constraints_matrix.py
    uv run python tests/playground/constraints_matrix.py --mode both --out runs/constraints.json
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import sys
import time
from typing import Any

import httpx

DEFAULT_URL = "http://localhost:8088"
TASK = {
    "task": "Summarize an incident report into 3 bullets.",
    "task_type": "summarization",
    "difficulty": "medium",
    "expected_input_tokens": 1500,
    "expected_output_tokens": 120,
}

# Each entry: (label, constraint-dict). Edge values chosen to probe 422 / relaxation paths.
SINGLETONS: list[tuple[str, dict[str, Any]]] = [
    ("provider=anthropic", {"allowed_providers": ["anthropic"]}),
    ("provider=google", {"allowed_providers": ["google"]}),
    ("provider=openai", {"allowed_providers": ["openai"]}),
    ("candidate=opus", {"candidate_models": ["claude-opus-4-8"]}),
    ("candidate=bogus", {"candidate_models": ["does-not-exist-xyz"]}),
    ("excluded=flash", {"excluded_models": ["gemini-2.5-flash"]}),
    ("max_cost=0.0001", {"max_cost_per_call": 0.0001}),
    ("max_cost=1.0", {"max_cost_per_call": 1.0}),
    ("min_quality=0.99", {"min_quality": 0.99}),
    ("min_quality=0.5", {"min_quality": 0.5}),
    ("cache_required", {"require_prompt_caching": True}),
    ("ctx_window=999M", {"require_context_window": 999_999_999}),
    ("ctx_window=128k", {"require_context_window": 128000}),
    ("latency=1ms", {"max_latency_ms": 1}),
]

# Curated subset for pairwise (combos most likely to interact / conflict).
PAIRWISE_SUBSET = [
    "provider=anthropic",
    "candidate=bogus",
    "max_cost=0.0001",
    "min_quality=0.99",
    "ctx_window=999M",
    "cache_required",
]


def classify(status: int, body: Any) -> tuple[str, list[str]]:
    if status == 422:
        return "no_candidates", []
    if status >= 400:
        detail = ""
        if isinstance(body, dict):
            detail = body.get("detail", "") or body.get("title", "")
        return f"bad_request({status}:{str(detail)[:24]})", []
    warnings = body.get("warnings", []) if isinstance(body, dict) else []
    relax = [w for w in warnings if "no_model" in w or "relax" in w or "budget" in w]
    return ("relaxed" if relax else "clean"), warnings


def run_one(c: httpx.Client, ns: str, constraints: dict[str, Any]) -> dict[str, Any]:
    body = {
        "task": TASK,
        "cost_quality_tradeoff": 5.0,
        "namespace": ns,
        "allow_llm_escalation": False,
        "constraints": constraints,
    }
    resp = c.post("/v1/recommend", json=body)
    try:
        payload = resp.json()
    except ValueError:
        payload = {"_raw": resp.text}
    outcome, warnings = classify(resp.status_code, payload)
    ranked = len(payload.get("ranked", [])) if isinstance(payload, dict) else 0
    model = (
        payload.get("recommended_model", {}).get("model_id") if isinstance(payload, dict) else None
    )
    return {
        "status": resp.status_code,
        "outcome": outcome,
        "ranked": ranked,
        "model": model or "-",
        "warnings": warnings,
    }


def print_row(label: str, r: dict[str, Any], width: int) -> None:
    print(
        f"  {label.ljust(width)}  {r['outcome']:<16} http={r['status']}  "
        f"ranked={r['ranked']}  model={r['model']}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=os.environ.get("MINIMA_URL", DEFAULT_URL))
    key_default = os.environ.get("MINIMA_KEY") or os.environ.get("MUBIT_API_KEY")
    ap.add_argument("--key", default=key_default)
    ns_default = f"fuzz-{int(time.time())}"
    ap.add_argument("--namespace", default=ns_default, help="isolated lane (default: fresh)")
    ap.add_argument("--mode", choices=["singleton", "pairwise", "both"], default="both")
    ap.add_argument("--out", default="", help="optional JSON dump path")
    args = ap.parse_args()

    if not args.key:
        print("ERROR: set MUBIT_API_KEY (or MINIMA_KEY) before running.", file=sys.stderr)
        return 2

    singletons = dict(SINGLETONS)
    rows: list[dict[str, Any]] = []
    headers = {"authorization": f"Bearer {args.key}", "content-type": "application/json"}

    print(f"\nconstraints_matrix  ->  {args.url}\nnamespace={args.namespace}  mode={args.mode}")
    label_w = max(len(lbl) for lbl in singletons)
    print(f"{'-' * 72}\n")

    with httpx.Client(base_url=args.url.rstrip("/"), headers=headers, timeout=60.0) as c:
        if args.mode in ("singleton", "both"):
            print("[singleton]")
            for lbl, cons in SINGLETONS:
                r = run_one(c, args.namespace, cons)
                r["label"] = lbl
                r["constraints"] = cons
                rows.append(r)
                print_row(lbl, r, label_w)
            print()

        if args.mode in ("pairwise", "both"):
            print("[pairwise]  (curated subset)")
            for a, b in itertools.combinations(PAIRWISE_SUBSET, 2):
                cons = {**singletons[a], **singletons[b]}
                lbl = f"{a} + {b}"
                r = run_one(c, args.namespace, cons)
                r["label"] = lbl
                r["constraints"] = cons
                rows.append(r)
                print_row(lbl, r, max(label_w, 40))
            print()

    tally: dict[str, int] = {}
    for r in rows:
        tally[r["outcome"]] = tally.get(r["outcome"], 0) + 1
    print(f"{'-' * 72}")
    print(f"{len(rows)} probes.  outcomes: {tally}")
    print(
        "  no_candidates=422 (constraints eliminated everything); relaxed=200 with a "
        "relaxation warning; clean=200 ranked normally.\n"
    )

    if args.out:
        from pathlib import Path

        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(
            json.dumps(rows, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        )
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
