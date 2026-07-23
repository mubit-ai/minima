"""Classifier program PR-4: pin the pure-python core of the training pipeline — label
maps, curated seeds, artifact identity, and the joint conformal fit — without importing
any of the pipeline's heavy dependencies (the scripts stay out of the wheel)."""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[2] / "scripts" / "classifier"
sys.path.insert(0, str(_SCRIPTS))

import common  # noqa: E402
from seeds import SEEDS  # noqa: E402

from minima.schemas.common import TaskType  # noqa: E402

WIRE_TYPES = {t.value for t in TaskType}


def test_pinned_task_types_match_the_wire_enum():
    assert set(common.TASK_TYPES) == WIRE_TYPES


def test_label_maps_emit_only_wire_task_types():
    assert set(common.CLINC_MAP.values()) <= WIRE_TYPES
    assert {label for _, label in common.RB_EVAL_MAP} <= WIRE_TYPES
    assert "oos" not in common.CLINC_MAP  # CLINC oos must NEVER become training data


def test_seeds_are_valid_and_deduped():
    assert set(SEEDS) <= WIRE_TYPES
    for label, texts in SEEDS.items():
        assert texts, f"empty seed class {label}"
        lowered = [t.lower().strip() for t in texts]
        assert len(set(lowered)) == len(lowered), f"duplicate seeds in {label}"


def test_true_oos_eval_disjoint_from_seeds():
    seed_texts = {t.lower().strip() for texts in SEEDS.values() for t in texts}
    assert not seed_texts & {t.lower().strip() for t in common.TRUE_OOS_EVAL}


def test_joint_abstain_fit_respects_alpha():
    import random

    rng = random.Random(3)
    dists = [rng.uniform(0.1, 0.9) for _ in range(400)]
    margins = [rng.uniform(0.0, 1.0) for _ in range(400)]
    for alpha in (0.05, 0.10):
        td, tm = common.fit_joint_abstain_thresholds(dists, margins, alpha)
        rate = sum(1 for d, m in zip(dists, margins, strict=True) if d > td or m < tm) / len(
            dists
        )
        assert rate <= alpha


def test_classifier_id_is_hash_derived_and_content_sensitive(tmp_path):
    (tmp_path / "head.npz").write_bytes(b"weights-v1")
    (tmp_path / "tokenizer.json").write_bytes(b"{}")
    a = common.derive_classifier_id(tmp_path, "potion-base-32M")
    assert a == common.derive_classifier_id(tmp_path, "potion-base-32M")  # stable
    (tmp_path / "head.npz").write_bytes(b"weights-v2")
    assert a != common.derive_classifier_id(tmp_path, "potion-base-32M")  # content-bound
    manifest = common.write_manifest(
        tmp_path, backbone="minishlab/potion-base-32M", dim=512, vocab=10, corpus_rows=1, alpha=0.05
    )
    assert manifest["classifier_id"].startswith("potion-base-32M-")
    # manifest.json itself is excluded from the hash — writing it must not change the id.
    assert manifest["classifier_id"] == common.derive_classifier_id(tmp_path, "potion-base-32M")
