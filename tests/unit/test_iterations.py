"""Phase C (service): the ``iterations`` field round-trips through OutcomeRecord and
FeedbackRequest, and the feedback endpoint persists it."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from minima.memory.records import OutcomeRecord
from minima.schemas.feedback import FeedbackRequest


def test_outcome_record_round_trips_iterations():
    rec = OutcomeRecord(model_id="claude-haiku-4-5", iterations=3)
    meta = rec.to_metadata()
    assert meta["iterations"] == 3
    parsed = OutcomeRecord.from_metadata(meta)
    assert parsed is not None
    assert parsed.iterations == 3


def test_outcome_record_legacy_metadata_defaults_iterations_none():
    legacy = {"kind": "outcome", "model_id": "claude-haiku-4-5"}  # no iterations key
    parsed = OutcomeRecord.from_metadata(legacy)
    assert parsed is not None
    assert parsed.iterations is None


def test_feedback_request_accepts_and_validates_iterations():
    req = FeedbackRequest(
        recommendation_id="rec-1",
        chosen_model_id="claude-haiku-4-5",
        outcome="success",
        iterations=5,
    )
    assert req.iterations == 5
    # iterations is optional
    assert (
        FeedbackRequest(
            recommendation_id="rec-1", chosen_model_id="m", outcome="success"
        ).iterations
        is None
    )
    with pytest.raises(ValidationError):
        FeedbackRequest(
            recommendation_id="rec-1", chosen_model_id="m", outcome="success", iterations=-1
        )


def test_feedback_endpoint_persists_iterations(client, fake_memory):
    """recommend -> feedback(iterations=N) writes iterations into the outcome record."""
    rec = client.post(
        "/v1/recommend",
        json={"task": {"task": "wire the loop turn counter", "task_type": "code"}},
    ).json()
    assert rec["recommendation_id"]

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": rec["recommended_model"]["model_id"],
            "outcome": "success",
            "quality_score": 0.9,
            "input_tokens": 100,
            "output_tokens": 40,
            "iterations": 4,
        },
    ).json()
    assert fb["accepted"] is True
    assert len(fake_memory.remembered) == 1
    written = fake_memory.remembered[0]["record"]
    assert written.iterations == 4
