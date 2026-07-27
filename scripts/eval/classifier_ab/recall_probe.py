"""Leg B closeout — is the recall failure the ricedb bug, or something else?

The A/B's Leg B could not clear its V5 crosscheck guard (0.50 against a 0.80 floor) and saw
identical queries return 16/13/16 evidence rows. `ricedb@fix/control-vector-search` (c76f5eb,
2026-07-14, unmerged) root-causes a failure whose shape is close: the control query handler's
lane filter dropped every semantic result for callers that ingest WITHOUT lane tags — naming
Minima's `batch_insert` — and fell through to a recency fallback returning "a UUID-ordered,
query-independent result set with a constant placeholder score of 0.5".

Dates line up (RESULTS.md 2026-06-12: crosscheck 100%, 40 evidence/prompt; this study
2026-07-27: 0.50, 7.3/prompt; fix 2026-07-14) but a date bracket is not a confirmation, and
one thing does NOT line up: a UUID-ordered fallback over a fixed index should be STABLE, while
the observed symptom was a varying count. So: two probes that discriminate, on a freshly
seeded lane with known contents, using shipped instrumentation only.

  P1  score signature   — MINIMA_RECALL_EXPLAIN_SAMPLE=1.0 surfaces Mubit's per-evidence
                          fusion breakdown. The bug predicts a constant score ~0.5, a
                          degenerate/absent semantic component, and a recency rank_by_mode.
  P2  query independence — two topically orthogonal queries, same lane, same limit. The bug
                          predicts near-identical, identically-ordered result sets; healthy
                          recall predicts disjoint, topic-skewed ones.
  P3  repeat stability  — the same query three times, to reproduce (or not) the 16/13/16
                          varying-count symptom that the fallback hypothesis does not explain.

    uv run python scripts/eval/classifier_ab/recall_probe.py --out reports/data/recall_probe.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO))

# Three topically orthogonal families. If recall is query-sensitive, a query drawn from one
# family must return that family's entries; if it is running the recency fallback, the family
# mix of the results will be indifferent to which query was asked.
FAMILIES = {
    "python": [
        "Refactor this recursive Python parser into an iterative loop over an explicit stack",
        "Fix the IndexError raised when the list comprehension slices an empty dataframe",
        "Add type annotations to the async database connection pool module",
        "Write a pytest fixture that mocks the HTTP client and asserts the retry backoff",
        "Convert this synchronous requests call into an aiohttp coroutine with a timeout",
    ],
    "cooking": [
        "How long should I braise beef short ribs in red wine before the meat falls apart",
        "Substitute for buttermilk in a soda bread recipe when the shop has none left",
        "Why does my sourdough starter smell like acetone after four days on the counter",
        "Best temperature to roast a whole chicken so the skin crisps without drying it",
        "Should I salt the aubergine before frying it or does that make it soggy",
    ],
    "finance": [
        "Explain the difference between an ISA and a SIPP for UK retirement contributions",
        "How is capital gains tax calculated when shares are sold across two tax years",
        "What happens to a fixed-rate mortgage when the base rate rises mid-term",
        "Compare index tracker fees against an actively managed equity fund over ten years",
        "Does dollar cost averaging beat lump sum investing in a rising market",
    ],
}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--per-family", type=int, default=20)
    ap.add_argument("--limit", type=int, default=25)
    args = ap.parse_args()

    import structlog

    from minima.config import Settings
    from minima.memory.adapter import MubitMemory
    from minima.memory.keys import build_content, task_fingerprint, versioned_cluster
    from minima.memory.records import OutcomeRecord
    from minima.seeding.items import SeedItem, build_item

    captured: list[dict] = []

    def capture(logger, method_name, event_dict):
        if event_dict.get("event") == "recall_explain":
            captured.append(dict(event_dict))
        return event_dict

    structlog.configure(processors=[capture, structlog.processors.JSONRenderer()])

    settings = Settings()
    memory = MubitMemory(settings=settings)
    lane = f"{settings.minima_lane_prefix}:recallprobe-{uuid.uuid4().hex[:8]}"
    print(f"lane {lane}")

    # --- seed -------------------------------------------------------------------------------
    items, family_of = [], {}
    for family, prompts in FAMILIES.items():
        for i in range(args.per_family):
            prompt = f"{prompts[i % len(prompts)]} (variant {i})"
            record = OutcomeRecord(
                model_id=f"probe-model-{i % 3}",
                task_type="qa",
                difficulty="medium",
                task_fingerprint=task_fingerprint(prompt),
                task_cluster=versioned_cluster("qa", "medium"),
                cost_usd=0.001,
                quality_score=0.8,
                outcome="success",
                evidence_source="dataset",
                source_dataset="recall-probe",
            )
            item_id = f"probe:{family}:{i}"
            family_of[item_id] = family
            items.append(
                build_item(
                    SeedItem(
                        item_id=item_id,
                        content=build_content("qa", "medium", prompt),
                        record=record,
                        env_tags=[],
                    )
                )
            )
    seeded = 0
    for start in range(0, len(items), 100):
        res = await memory.batch_insert(
            run_id=lane, items=items[start : start + 100], deduplicate=True
        )
        seeded += res if isinstance(res, int) else len(items[start : start + 100])
    print(f"seeded {len(items)} items ({seeded} accepted); settling…")
    await asyncio.sleep(10)

    # Recall returns content, not our item_id, so map an entry back to its family by matching
    # the seeded prompt text. Keyed on a distinctive prefix of each prompt rather than the
    # family name, which never appears in the text.
    prefix_to_family = {p[:40].lower(): f for f, ps in FAMILIES.items() for p in ps}

    def family_mix(result):
        mix: dict[str, int] = {}
        for e in result.evidence:
            body = e.content.lower()
            fam = next((f for pre, f in prefix_to_family.items() if pre in body), "unknown")
            mix[fam] = mix.get(fam, 0) + 1
        return mix

    async def recall(query):
        return await memory.recall(query=query, lane=lane, limit=args.limit, timeout_ms=20_000)

    out: dict = {"lane": lane, "seeded": len(items), "limit": args.limit}

    # --- P2: query independence -------------------------------------------------------------
    probes = {f: f"{prompts[0]} — please help" for f, prompts in FAMILIES.items()}
    p2 = {}
    for family, query in probes.items():
        r = await recall(query)
        p2[family] = {
            "n": len(r.evidence),
            "ids": [e.entry_id for e in r.evidence],
            "scores": [round(e.score, 6) for e in r.evidence],
            "family_mix": family_mix(r),
            "degraded": r.degraded,
            "timed_out": r.timed_out,
            "error": r.error,
        }
        print(f"  P2 {family:9} n={len(r.evidence):3} mix={family_mix(r)}")
    fams = list(p2)
    overlaps = {}
    for i, a in enumerate(fams):
        for b in fams[i + 1 :]:
            sa, sb = set(p2[a]["ids"]), set(p2[b]["ids"])
            overlaps[f"{a}|{b}"] = {
                "jaccard": (len(sa & sb) / len(sa | sb)) if (sa | sb) else 0.0,
                "identical_order": p2[a]["ids"] == p2[b]["ids"],
            }
    out["p2_query_independence"] = {"per_query": p2, "overlaps": overlaps}

    # --- P3: repeat stability ---------------------------------------------------------------
    q = probes["python"]
    repeats = []
    for _ in range(3):
        r = await recall(q)
        repeats.append({"n": len(r.evidence), "ids": [e.entry_id for e in r.evidence]})
        time.sleep(0.5)
    out["p3_repeat_stability"] = {
        "counts": [x["n"] for x in repeats],
        "all_identical": len({tuple(x["ids"]) for x in repeats}) == 1,
    }
    print(f"  P3 repeat counts {[x['n'] for x in repeats]} "
          f"identical={out['p3_repeat_stability']['all_identical']}")

    # --- P1: score signature ----------------------------------------------------------------
    captured.clear()
    settings.minima_recall_explain_sample = 1.0
    memory_x = MubitMemory(settings=settings)
    r = await memory_x.recall(query=q, lane=lane, limit=args.limit, timeout_ms=20_000)
    scores = [e.score for e in r.evidence]
    out["p1_score_signature"] = {
        "n": len(r.evidence),
        "scores": [round(s, 6) for s in scores],
        "distinct_scores": len({round(s, 6) for s in scores}),
        "all_half": bool(scores) and all(abs(s - 0.5) < 1e-6 for s in scores),
        "explain_events": captured,
    }
    print(f"  P1 n={len(scores)} distinct_scores={out['p1_score_signature']['distinct_scores']} "
          f"all_0.5={out['p1_score_signature']['all_half']}")
    if captured:
        print(f"  P1 recall_explain captured: {len(captured)} event(s)")
    else:
        print("  P1 recall_explain NOT emitted (Mubit returned no explain_info)")

    args.out.write_text(json.dumps(out, indent=1))
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    if not os.environ.get("MUBIT_API_KEY"):
        raise SystemExit("MUBIT_API_KEY required (source the repo .env)")
    asyncio.run(main())
