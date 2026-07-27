"""Gate S5 — is the head I measured locally the head prod is serving?

Free: /v1/recommend never runs a model, and auth is pass-through, so a format-valid bearer
is enough to read back `classification_profile`. Compares prod's `final_task_type` against
the local A3a arm on the same prompts.

    uv run python scripts/eval/classifier_ab/prod_parity.py --eval-set <clean.jsonl> --n 100
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

HEALTH = "https://api.minima.sh/v1/health"
RECOMMEND = "https://api.minima.sh/v1/recommend"
BEARER = "mbt_live_0000000000000000000000000000000000000000"


def _post(prompt: str) -> dict | None:
    body = json.dumps({"task": {"task": prompt}}).encode()
    req = urllib.request.Request(
        RECOMMEND,
        data=body,
        headers={"Authorization": f"Bearer {BEARER}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read())
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-set", type=Path, required=True)
    ap.add_argument("--artifact", type=Path, required=True)
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    with urllib.request.urlopen(HEALTH, timeout=30) as r:
        health = json.loads(r.read())
    prod_id = health.get("classifier", {}).get("id")

    from arms import build_arms

    arms = build_arms(args.artifact)
    local_id = arms["A3a"].embed.classifier_id

    rows = [json.loads(ln) for ln in args.eval_set.open() if json.loads(ln)["label"]]
    rows = rows[:: max(1, len(rows) // args.n)][: args.n]

    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(pool.map(lambda r: _post(r["text"]), rows))

    compared = agree = 0
    src: dict[str, int] = {}
    mismatches = []
    for r, resp in zip(rows, responses, strict=True):
        if not resp:
            continue
        cp = resp.get("classification_profile") or {}
        prod_type = cp.get("final_task_type")
        s = cp.get("task_type_source", "?")
        src[s] = src.get(s, 0) + 1
        local = arms["A3a"].predict(r["text"]).task_type
        compared += 1
        if prod_type == local:
            agree += 1
        elif len(mismatches) < 15:
            mismatches.append(
                {"task": r["task"], "gold": r["label"], "prod": prod_type,
                 "local": local, "source": s, "text": r["text"][:160]}
            )

    rate = agree / compared if compared else 0.0
    out = {
        "prod_classifier_id": prod_id,
        "local_classifier_id": local_id,
        "id_match": prod_id == local_id,
        "compared": compared,
        "requested": len(rows),
        "agreement": rate,
        "prod_source_mix": src,
        "mismatches": mismatches,
        "gate_s5_pass": prod_id == local_id and rate >= 0.95,
    }
    args.out.write_text(json.dumps(out, indent=1))
    print(f"prod id  : {prod_id}")
    print(f"local id : {local_id}   match={out['id_match']}")
    print(f"compared : {compared}/{len(rows)}   agreement={rate:.3f}")
    print(f"source   : {src}")
    print(f"S5 {'PASS' if out['gate_s5_pass'] else 'FAIL'}")


if __name__ == "__main__":
    main()
