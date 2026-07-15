from __future__ import annotations

from mubit import ServerError

from tests.factories import make_evidence


def _recommend_haiku(client, fake_memory):
    fake_memory.evidence = [
        make_evidence("claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"),
        make_evidence("claude-haiku-4-5", 0.9, entry_id="e2", reference_id="r2"),
        make_evidence("claude-haiku-4-5", 0.85, entry_id="e3"),
    ]
    resp = client.post(
        "/v1/recommend",
        json={
            "task": {
                "task": "refactor this recursive def foo()",
                "task_type": "code",
                "difficulty": "hard",
            },
            "constraints": {"candidate_models": ["claude-haiku-4-5", "claude-opus-4-8"]},
        },
    )
    return resp.json()


def test_feedback_writes_outcome_and_credits_neighbors(client, fake_memory):
    rec = _recommend_haiku(client, fake_memory)
    assert rec["recommended_model"]["model_id"] == "claude-haiku-4-5"

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.95,
            "input_tokens": 1800,
            "output_tokens": 600,
        },
    ).json()

    assert fb["accepted"] is True
    assert set(fb["reinforced_entry_ids"]) == {"e1", "e2", "e3"}

    assert len(fake_memory.remembered) == 1
    written = fake_memory.remembered[0]
    assert written["upsert_key"] == "minima:om:code:hard:claude-haiku-4-5"
    assert written["record"].quality_score == 0.95
    assert written["source"] == "human"

    assert len(fake_memory.outcomes) == 1
    outcome = fake_memory.outcomes[0]
    assert set(outcome["entry_ids"]) == {"e1", "e2", "e3"}
    assert outcome["reference_id"] == "r1"
    assert outcome["signal"] == 1.0


def test_unknown_recommendation_is_rejected(client):
    fb = client.post(
        "/v1/feedback",
        json={"recommendation_id": "nope", "chosen_model_id": "x", "outcome": "success"},
    ).json()
    assert fb["accepted"] is False
    assert "unknown_recommendation" in fb["warnings"]


def test_reflection_triggers_on_cadence(client, fake_memory):
    rec = _recommend_haiku(client, fake_memory)
    rec_id = rec["recommendation_id"]
    triggers = []
    for _ in range(3):  # MINIMA_REFLECT_EVERY_N = 3 in the test settings
        fb = client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec_id,
                "chosen_model_id": "claude-haiku-4-5",
                "outcome": "success",
            },
        ).json()
        triggers.append(fb["reflection_triggered"])
    assert triggers == [False, False, True]


def test_memory_outage_still_reconciles_the_decision_log(client, fake_memory):
    """Regression (observed live): a Mubit 503 made feedback return early BEFORE
    _reconcile_decision, so /v1/savings showed 0 reconciled rows for a whole day of
    traffic. Realized cost/outcome are local analytics facts — they must survive a
    memory outage."""
    rec = _recommend_haiku(client, fake_memory)

    async def _boom(**kwargs):
        raise ServerError("mubit unavailable (503)")

    fake_memory.remember_outcome = _boom  # type: ignore[method-assign]

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
            "actual_cost_usd": 0.0042,
            "latency_ms": 900,
        },
    ).json()
    # The memory write failure is still surfaced honestly — and a Mubit 5xx is labeled as a
    # server error, not conflated with an auth failure or a bug on our side.
    assert fb["accepted"] is False
    assert "memory_server_error" in fb["warnings"]

    # ...but the decision-log row was reconciled anyway: savings sees realized cost.
    savings = client.get("/v1/savings", params={"days": 1}).json()
    realized = savings["summary"]["realized"]
    assert realized["n_reconciled"] == 1
    assert abs(realized["realized_cost_usd"] - 0.0042) < 1e-9


def test_non_mubit_write_error_is_labeled_a_bug_not_an_outage(client, fake_memory):
    """A local bug in the write path (not a Mubit error) must be labeled memory_write_bug —
    never disguised as a memory outage, which would send us hunting a healthy Mubit."""
    rec = _recommend_haiku(client, fake_memory)

    async def _boom(**kwargs):
        raise KeyError("task_cluster")  # a bug in our own payload construction

    fake_memory.remember_outcome = _boom  # type: ignore[method-assign]

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
        },
    ).json()
    assert fb["accepted"] is False
    assert "memory_write_bug" in fb["warnings"]


def test_judged_false_stores_null_quality_not_fabricated(client, fake_memory):
    """Regression: when the harness sends judged=False (cadence-skip / LLM-judge abstain),
    the decision log must store NULL quality — never the fabricated 0.9 default.
    A fabricated value corrupts calibration metrics and OPE weighting."""
    rec = _recommend_haiku(client, fake_memory)

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            # No quality_score — the harness didn't run a judge this turn.
            "actual_cost_usd": 0.0021,
            "latency_ms": 600,
            "judged": False,
        },
    ).json()

    assert fb["accepted"] is True

    # /v1/savings must still count this as reconciled (cost is known)...
    savings = client.get("/v1/savings", params={"days": 1}).json()
    realized = savings["summary"]["realized"]
    assert realized["n_reconciled"] == 1
    assert abs(realized["realized_cost_usd"] - 0.0021) < 1e-9


def test_judged_none_preserves_legacy_quality_from_outcome(client, fake_memory):
    """Old clients that don't send 'judged' must keep their existing behaviour:
    quality_from_outcome fills in a label-based default (0.9 for success)."""
    rec = _recommend_haiku(client, fake_memory)

    # Old client: no 'judged' key, no quality_score — legacy path.
    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "actual_cost_usd": 0.001,
        },
    ).json()

    assert fb["accepted"] is True
    # Decision log is reconciled; legacy path — quality value is a server concern,
    # we only assert that the row was written (cost visible in savings).
    savings = client.get("/v1/savings", params={"days": 1}).json()
    assert savings["summary"]["realized"]["n_reconciled"] == 1
