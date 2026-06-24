"""Dump every Minima endpoint's JSON response to runs/playground_p1/ for diffing later.

Run this against a live Minima server (`make run`) and the responses are written one file
per endpoint, pretty-printed with sorted keys. Volatile fields (UUIDs, timestamps, latency,
catalog_version) are scrubbed to ``"<scrubbed>"`` by default so successive runs diff cleanly;
pass ``--raw`` to capture the untouched wire payload.

It writes into an isolated namespace (``playground-p1``) so your default lane is not
polluted and the responses are reproducible.

    set -a; source .env; set +a
    uv run python tests/playground/dump_endpoints.py
    uv run python tests/playground/dump_endpoints.py --raw --out runs/playground_p1_raw

Compare two runs:

    diff -r runs/playground_p1/ runs/playground_p1.prev/
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx

DEFAULT_URL = "http://localhost:8088"
NAMESPACE = os.environ.get("PLAYGROUND_NS", "playground-p1")

VOLATILE_KEYS = {
    "recommendation_id",
    "workflow_recommendation_id",
    "latency_ms",
    "est_latency_ms",
    "catalog_version",
    "idempotency_key",
}


def _is_volatile(key: str) -> bool:
    return key in VOLATILE_KEYS or key.endswith("_at") or "timestamp" in key.lower()


def scrub(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: ("<scrubbed>" if _is_volatile(k) else scrub(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    return obj


def write_json(out: Path, name: str, payload: Any, do_scrub: bool) -> None:
    data = scrub(payload) if do_scrub else payload
    path = out / f"{name}.json"
    path.write_text(json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def print_result(ok: bool, name: str, status: int, path: Path) -> None:
    tag = "PASS" if ok else "FAIL"
    print(f"  [{tag}]  {name:<14}  HTTP {status}  ->  {path}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=os.environ.get("MINIMA_URL", DEFAULT_URL))
    key_default = os.environ.get("MINIMA_KEY") or os.environ.get("MUBIT_API_KEY")
    ap.add_argument("--key", default=key_default)
    ap.add_argument(
        "--out", default=os.environ.get("PLAYGROUND_OUT", "runs/playground_p1"), help="output dir"
    )
    ap.add_argument("--raw", action="store_true", help="do not scrub volatile fields")
    ap.add_argument("--namespace", default=NAMESPACE, help="isolated namespace lane")
    args = ap.parse_args()

    if not args.key:
        print("ERROR: set MUBIT_API_KEY (or MINIMA_KEY) before running.", file=sys.stderr)
        return 2

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    headers = {"authorization": f"Bearer {args.key}"}
    ns = args.namespace
    do_scrub = not args.raw
    failures = 0
    manifest: list[dict[str, Any]] = []

    print(f"\nDump endpoints  ->  {args.url}\nnamespace={ns}  scrubbed={do_scrub}\n{'-' * 64}")

    with httpx.Client(base_url=args.url.rstrip("/"), headers=headers, timeout=60.0) as c:

        def get(name: str, path: str) -> httpx.Response:
            return c.get(path)

        def post(name: str, path: str, body: dict[str, Any]) -> httpx.Response:
            return c.post(path, json=body, headers={**headers, "content-type": "application/json"})

        def dump(name: str, resp: httpx.Response) -> Any:
            nonlocal failures
            ok = resp.is_success
            try:
                payload = resp.json()
            except ValueError:
                payload = {"_raw": resp.text}
            write_json(out, name, payload, do_scrub)
            print_result(ok, name, resp.status_code, out / f"{name}.json")
            failures += not ok
            manifest.append(
                {
                    "endpoint": name,
                    "http_status": resp.status_code,
                    "ok": ok,
                    "file": f"{name}.json",
                }
            )
            return payload

        print("\n[GET] health")
        dump("health", get("health", "/v1/health"))

        print("\n[GET] models")
        dump("models", get("models", "/v1/models?include_stale=true"))

        print("\n[POST] recommend")
        rec = dump(
            "recommend",
            post(
                "recommend",
                "/v1/recommend",
                {
                    "task": {
                        "task": "Summarize a 2-page incident report into 3 bullet points.",
                        "task_type": "summarization",
                        "difficulty": "medium",
                        "expected_input_tokens": 1800,
                        "expected_output_tokens": 120,
                    },
                    "cost_quality_tradeoff": 5.0,
                    "namespace": ns,
                    "allow_llm_escalation": False,
                    "explain": True,
                },
            ),
        )

        rec_id = rec.get("recommendation_id") if isinstance(rec, dict) else None
        model_id = (
            rec.get("recommended_model", {}).get("model_id") if isinstance(rec, dict) else None
        )

        print("\n[POST] recommend/workflow")
        dump(
            "workflow",
            post(
                "workflow",
                "/v1/recommend/workflow",
                {
                    "steps": [
                        {
                            "step_id": "extract",
                            "task": {
                                "task": "Extract action items from the incident report.",
                                "task_type": "extraction",
                                "difficulty": "easy",
                                "expected_input_tokens": 1800,
                                "expected_output_tokens": 200,
                            },
                        },
                        {
                            "step_id": "summarize",
                            "task": {
                                "task": "Summarize the action items for an executive.",
                                "task_type": "summarization",
                                "difficulty": "easy",
                                "expected_output_tokens": 80,
                            },
                            "depends_on": ["extract"],
                        },
                    ],
                    "cost_quality_tradeoff": 5.0,
                    "namespace": ns,
                    "allow_llm_escalation": False,
                },
            ),
        )

        print("\n[POST] feedback")
        fb_body: dict[str, Any] = {
            "chosen_model_id": model_id or "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
            "input_tokens": 1760,
            "output_tokens": 110,
            "actual_cost_usd": 0.0021,
            "latency_ms": 420,
            "verified_in_production": True,
            "namespace": ns,
        }
        if rec_id:
            fb_body["recommendation_id"] = rec_id
        dump("feedback", post("feedback", "/v1/feedback", fb_body))

        print("\n[GET] strategies")
        dump("strategies", get("strategies", f"/v1/strategies?namespace={ns}&max_strategies=5"))

        print("\n[GET] savings")
        dump("savings", get("savings", f"/v1/savings?namespace={ns}&days=7"))

        print("\n[GET] calibration")
        dump("calibration", get("calibration", f"/v1/calibration?namespace={ns}&days=7"))

    manifest_obj = {
        "url": args.url,
        "namespace": ns,
        "scrubbed": do_scrub,
        "endpoints": manifest,
    }
    (out / "_manifest.json").write_text(
        json.dumps(manifest_obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    )

    print(f"\n{'-' * 64}")
    print(f"Wrote {len(manifest)} endpoints to {out}/  ({failures} failed)")
    print("Diff a previous run with:  diff -r runs/playground_p1/ runs/playground_p1.prev/\n")
    return failures


if __name__ == "__main__":
    sys.exit(main())
