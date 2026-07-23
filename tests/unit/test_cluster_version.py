"""Classifier program PR-2: cluster-key-space versioning must be a byte-identical no-op
at the v1 default, and a pure signature-slot suffix at any later version — so PR-9's flip
changes every downstream join atomically with zero consumer edits, and rollback is clean.
"""

from __future__ import annotations

import time

from minima.memory.keys import (
    CLUSTER_KEY_VERSION,
    strip_cluster_version,
    task_cluster,
    versioned_cluster,
)
from minima.recommender.pairs import MemoryPairStore, assemble_pair
from minima.schemas.feedback import FeedbackRequest


def test_v1_is_byte_identical_to_the_historical_key():
    assert CLUSTER_KEY_VERSION == "v1"
    assert versioned_cluster("code", "hard") == task_cluster("code", "hard") == "code:hard"
    assert versioned_cluster("code", "hard", "v1") == "code:hard"


def test_later_versions_ride_the_signature_slot():
    assert versioned_cluster("code", "hard", "v2") == "code:hard:v2"
    assert versioned_cluster("other", "easy", "v3") == "other:easy:v3"


def test_strip_round_trips_every_shape():
    assert strip_cluster_version("code:hard") == "code:hard"
    assert strip_cluster_version("code:hard:v2") == "code:hard"
    assert strip_cluster_version("code:hard:1a2b3c4d") == "code:hard"
    assert strip_cluster_version("general") == "general"


def _decision(rec_id: str, cluster: str, model: str):
    from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord

    return DecisionRecord(
        recommendation_id=rec_id,
        org_id="org",
        lane="minima:default",
        cluster=cluster,
        task_type="code",
        difficulty="hard",
        fingerprint="f",
        ts=time.time(),
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id=model,
        escalated=False,
        explored=False,
        candidates=[
            CandidateSnapshot(
                model_id=model,
                predicted_success=0.9,
                confidence=0.5,
                est_cost_usd=0.001,
                propensity=1.0,
            )
        ],
        realized_outcome="failure",
        evidence_source="gate",
    )


def test_preference_pairs_match_across_key_space_versions():
    """A recovery chain that spans the v1→v2 flip must still pair: the parent decided
    under `code:hard`, the child under `code:hard:v2` — same task cluster, one key flip."""
    store = MemoryPairStore()
    parent = _decision("rec-parent", "code:hard", "cheap-model")
    child_req = FeedbackRequest(
        recommendation_id="rec-child",
        chosen_model_id="premium-model",
        outcome="success",
        evidence_source="gate",
        escalation_reason="gate_failed",
    )
    pair = assemble_pair(
        parent,
        child_req,
        child_cluster="code:hard:v2",
        child_evidence_source="gate",
    )
    assert pair is not None
    store.put(pair)
    # win_rates joins version-stripped from either side of the flip.
    for query in ("code:hard", "code:hard:v2"):
        rates = store.win_rates(query)
        assert rates, f"no pairs surfaced for {query}"
