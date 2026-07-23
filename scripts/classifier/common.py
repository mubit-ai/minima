"""Pure-python pieces of the classifier training pipeline (classifier program PR-4).

Everything here is import-safe with the core dependency set (no numpy/torch/datasets) so
tests can pin the label maps, the artifact-identity derivation, and the conformal
threshold fit hermetically. The heavy stages live in build_corpus.py / train.py /
evaluate.py behind PEP 723 script metadata and are never imported by the service.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

# The 11 wire task types (schemas/common.py TaskType) — pinned here so a taxonomy edit
# breaks the pipeline loudly instead of silently minting unknown labels.
TASK_TYPES = (
    "code",
    "summarization",
    "extraction",
    "qa",
    "reasoning",
    "classification",
    "translation",
    "creative",
    "rag",
    "tool_use",
    "other",
)

# CLINC150 intent -> Minima task type. Conservative: unmapped intents are DROPPED, and the
# CLINC `oos` split is NEVER training data — most of its rows are in-scope qa under
# Minima's open taxonomy, and training `other` on it teaches the head that general
# questions are unpriceable (measured in the 2026-07-23 spike: removing it was the single
# biggest probe improvement).
CLINC_MAP = {
    "translate": "translation",
    "alarm": "tool_use", "timer": "tool_use", "reminder": "tool_use",
    "reminder_update": "tool_use", "todo_list": "tool_use", "todo_list_update": "tool_use",
    "calendar": "tool_use", "calendar_update": "tool_use", "play_music": "tool_use",
    "order": "tool_use", "order_checks": "tool_use", "book_flight": "tool_use",
    "book_hotel": "tool_use", "text": "tool_use", "share_location": "tool_use",
    "smart_home": "tool_use", "update_playlist": "tool_use", "shopping_list": "tool_use",
    "shopping_list_update": "tool_use", "pay_bill": "tool_use", "transfer": "tool_use",
    "schedule_meeting": "tool_use", "make_call": "tool_use", "car_rental": "tool_use",
    "definition": "qa", "weather": "qa", "date": "qa", "time": "qa", "distance": "qa",
    "spelling": "qa", "nutrition_info": "qa", "calories": "qa", "recipe": "qa",
    "exchange_rate": "qa", "interest_rate": "qa", "timezone": "qa",
    "measurement_conversion": "qa", "plug_type": "qa", "vaccines": "qa",
    "flight_status": "qa", "gas_type": "qa", "oil_change_when": "qa",
    "oil_change_how": "qa", "tire_pressure": "qa", "how_busy": "qa",
    "international_visa": "qa", "travel_notification": "qa", "travel_alert": "qa",
    "credit_score": "qa", "insurance": "qa", "w2": "qa", "income": "qa",
    "calculator": "reasoning",
    "greeting": "other", "goodbye": "other", "thank_you": "other",
    "what_is_your_name": "other", "who_made_you": "other", "how_old_are_you": "other",
    "are_you_a_bot": "other", "meaning_of_life": "other",
    "tell_joke": "other", "fun_fact": "other", "what_are_your_hobbies": "other",
    "what_can_i_ask_you": "other", "whisper_mode": "other",
}

# RouterBench eval-name substring -> Minima task type.
RB_EVAL_MAP = (
    ("mbpp", "code"), ("humaneval", "code"),
    ("gsm8k", "reasoning"), ("grade-school-math", "reasoning"),
    ("hellaswag", "reasoning"), ("winogrande", "reasoning"),
    ("mmlu", "qa"), ("arc", "qa"),
    ("consensus_summary", "summarization"), ("abstract2title", "summarization"),
    ("bias_detection", "classification"),
    ("hard_translations", "translation"),
)

RB_CAP_PER_TYPE = 350
# Measured 2026-07-23: capping RouterBench's qa/reasoning mass HURT across the board
# (macro-F1 0.80 -> 0.69) — benchmark rows carry real signal; keep them. The one
# genuine magnet is CLINC's imperative command register (tool_use), capped below.
RB_TYPE_CAPS: dict[str, int] = {}
CLINC_CAP_PER_TYPE = 300
CLINC_TYPE_CAPS = {"tool_use": 200}

# Minima-scoped true-OOS eval set: nothing here fits any of the 11 types. Benchmark OOS
# splits (CLINC oos) are NOT valid here — under an open taxonomy most of their rows are
# answerable qa. Fragments, fillers, and context-dependent references are the real OOS.
TRUE_OOS_EVAL = (
    "asdkfj qwerlkj zxcmvn", "🎉🎉🎉", "test test test 123", "aaaaaaaaaaaaaaaaaa",
    "hello?", "u there", "kk", "hmmmm", ".", "??", "nvm", "wait",
    "lorem ipsum dolor sit amet consectetur", "9f8a7b6c5d4e3f2a1b0c",
    "the quick brown fox jumps over the lazy dog",
    "purple monkey dishwasher banana telescope",
    "continue", "go on", "and then?", "same as before", "do it again but better",
    "that's not what I meant", "you already said that", "try again",
    "why did you stop", "make it pop", "no not like that", "the other one",
    "undo that", "as discussed earlier", "per my last message", "see above",
)


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def dedupe(rows: list[dict]) -> list[dict]:
    """Case-insensitive text dedupe, first occurrence wins."""
    seen: set[str] = set()
    out: list[dict] = []
    for r in rows:
        k = r["text"].lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def derive_classifier_id(artifact_dir: Path, backbone_slug: str) -> str:
    """The artifact IS the identity: sha256 over every bundle file, sorted by name, so an
    artifact change can never ship under an unbumped classifier_id (hand-setting is how
    silent drift happens)."""
    h = hashlib.sha256()
    for f in sorted(p for p in artifact_dir.iterdir() if p.name != "manifest.json"):
        h.update(f.name.encode())
        h.update(f.read_bytes())
    return f"{backbone_slug}-{h.hexdigest()[:12]}"


def fit_joint_abstain_thresholds(
    distances: list[float],
    margins: list[float],
    alpha: float = 0.05,
) -> tuple[float, float]:
    """Fit (tau_dist, tau_margin) so the UNION abstain rate on the calibration split is
    <= alpha while abstaining as much true mass as the budget allows. Two independent
    alpha-quantile tests union to ~2*alpha (measured 13.6% in the spike) — the joint grid
    is what keeps the false-abstain guarantee honest."""
    if len(distances) != len(margins) or not distances:
        raise ValueError("distances and margins must be equal-length and non-empty")

    def quantile(values: list[float], q: float) -> float:
        v = sorted(values)
        idx = min(len(v) - 1, max(0, round(q * (len(v) - 1))))
        return v[idx]

    n = len(distances)
    best: tuple[float, float, float] | None = None
    qd = 0.95
    while qd < 0.9999:
        qm = 0.0
        while qm < alpha:
            td, tm = quantile(distances, qd), quantile(margins, qm)
            rate = sum(1 for d, m in zip(distances, margins, strict=True) if d > td or m < tm) / n
            if rate <= alpha and (best is None or rate > best[0]):
                best = (rate, td, tm)
            qm += 0.005
        qd += 0.005
    if best is None:
        # Degenerate calibration split — abstain on distance alone at the alpha quantile.
        return quantile(distances, 1 - alpha), 0.0
    return best[1], best[2]


def write_manifest(
    artifact_dir: Path,
    *,
    backbone: str,
    dim: int,
    vocab: int,
    corpus_rows: int,
    alpha: float,
    extra: dict | None = None,
) -> dict:
    slug = backbone.rsplit("/", 1)[-1].replace(".", "").replace("_", "-")
    manifest = {
        "classifier_id": derive_classifier_id(artifact_dir, slug),
        "backbone": backbone,
        "dim": dim,
        "vocab": vocab,
        "corpus_rows": corpus_rows,
        "alpha": alpha,
        **(extra or {}),
    }
    (artifact_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))
    return manifest
