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
    # The just-upserted durable record is the primary reference: guaranteed resolvable,
    # so one bad neighbor ref can never sink the whole reinforcement call.
    assert outcome["reference_id"] == "rec-fake-1"
    assert outcome["signal"] == 1.0


def test_lookup_neighbors_reinforce_via_fact_uuid_not_node_id(client, fake_memory):
    """Keyed-lookup neighbors carry numeric core-plane node ids as entry_id — the
    reinforcement votes must land on their control-plane fact UUID instead, and a
    node id with no known UUID is dropped rather than sent as an unlandable vote."""
    fact_uuid = "295ac2a9-e38f-429e-abb8-582feac73508"
    fake_memory.evidence = [
        make_evidence("claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"),
        make_evidence("claude-haiku-4-5", 0.9, entry_id="12345", reference_id=fact_uuid),
        make_evidence("claude-haiku-4-5", 0.85, entry_id="67890"),
    ]
    rec = client.post(
        "/v1/recommend",
        json={
            "task": {
                "task": "refactor this recursive def foo()",
                "task_type": "code",
                "difficulty": "hard",
            },
            "constraints": {"candidate_models": ["claude-haiku-4-5", "claude-opus-4-8"]},
        },
    ).json()

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
        },
    ).json()

    assert fb["accepted"] is True
    outcome = fake_memory.outcomes[0]
    assert set(outcome["entry_ids"]) == {"e1", fact_uuid}
    assert outcome["reference_id"] == "rec-fake-1"


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


def test_feedback_accepts_ladder_linkage_and_labeling_metadata(client, fake_memory):
    """A1 plumbing: parent_rec_id / escalation_reason / provider_model_snapshot /
    label_propensity validate and are accepted on the wire (reconciliation coverage
    lives in test_decisionlog.py)."""
    rec = _recommend_haiku(client, fake_memory)
    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
            "evidence_source": "judge",
            "parent_rec_id": "rec-previous-rung",
            "escalation_reason": "gate_failed",
            "provider_model_snapshot": "claude-haiku-4-5-20251001",
            "label_propensity": 0.15,
        },
    ).json()
    assert fb["accepted"] is True

    bad = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "escalation_reason": "because-i-said-so",
        },
    )
    assert bad.status_code == 422


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


def test_unlabeled_feedback_is_telemetry_only(client, fake_memory):
    """Truth rule: an unjudged turn (judged=False / evidence_source='none') says nothing
    about model quality. It must never touch the durable (cluster, model) record,
    neighbor reinforcement, or lessons — only the decision log's cost/latency columns."""
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
    assert "unlabeled_telemetry_only" in fb["warnings"]
    # No fabricated 0.9 enters the learning store, no +1 reinforcement, no lesson.
    assert fake_memory.remembered == []
    assert fake_memory.outcomes == []
    assert fake_memory.lessons == []

    # /v1/savings must still count this as reconciled (cost is known)...
    savings = client.get("/v1/savings", params={"days": 1}).json()
    realized = savings["summary"]["realized"]
    assert realized["n_reconciled"] == 1
    assert abs(realized["realized_cost_usd"] - 0.0021) < 1e-9


def test_infra_failure_is_telemetry_only_even_when_judged(client, fake_memory):
    """A provider 429/5xx/timeout is not a model-quality failure: error_cause='infra'
    must keep the outcome out of the success aggregate and reinforcement entirely —
    one rate-limit event must not overwrite a model's history for the cluster."""
    rec = _recommend_haiku(client, fake_memory)

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "failure",
            "quality_score": 0.0,
            "evidence_source": "judge",
            "error_cause": "infra",
            "actual_cost_usd": 0.0005,
        },
    ).json()

    assert fb["accepted"] is True
    assert "infra_failure_telemetry_only" in fb["warnings"]
    assert fake_memory.remembered == []
    assert fake_memory.outcomes == []


def test_legacy_client_outcome_is_a_human_label(client, fake_memory):
    """Old SDK clients (no judged flag) asserted the outcome themselves — that is a
    human label, so the loop still learns from them; but quality is stored strictly
    as supplied (None here), never a fabricated label default."""
    rec = _recommend_haiku(client, fake_memory)

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
    assert len(fake_memory.remembered) == 1
    written = fake_memory.remembered[0]["record"]
    assert written.evidence_source == "human"
    assert written.quality_score is None  # no 0.9 fabrication
    assert written.verified_in_production is False
    # Reinforcement still fires — the label is real, just unscored.
    assert len(fake_memory.outcomes) == 1
    assert fake_memory.outcomes[0]["signal"] == 1.0

    savings = client.get("/v1/savings", params={"days": 1}).json()
    assert savings["summary"]["realized"]["n_reconciled"] == 1


def test_gate_source_claims_verified_and_promotes_lesson_without_quality(client, fake_memory):
    """A deterministic gate verdict is the only origin that may claim
    verified-in-production; a gate pass with no judge score still promotes a lesson
    (deterministic verification beats any judge number)."""
    rec = _recommend_haiku(client, fake_memory)

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "evidence_source": "gate",
            "actual_cost_usd": 0.002,
        },
    ).json()

    assert fb["accepted"] is True
    assert fb["lesson_promoted"] is True
    written = fake_memory.remembered[0]
    assert written["record"].evidence_source == "gate"
    assert written["record"].verified_in_production is True
    assert written["record"].quality_score is None
    assert written["importance"] == "high"
    assert fake_memory.outcomes[0]["verified_in_production"] is True


def test_feedback_accumulates_history_in_the_durable_record(client, fake_memory):
    """Phase 1b: the (cluster, model) upsert is read-modify-write — counters and
    sample rings accumulate instead of last-write-wins wiping history (the n≈1 bug)."""
    from minima.memory.records import RecalledEvidence

    rec1 = _recommend_haiku(client, fake_memory)
    fb1 = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec1["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
            "evidence_source": "judge",
            "actual_cost_usd": 0.002,
            "output_tokens": 500,
        },
    ).json()
    assert fb1["accepted"] is True
    first_written = fake_memory.remembered[0]["record"]
    assert first_written.n_outcomes == 1
    assert first_written.cost_samples == [0.002]

    # The durable record is now dereferenceable (feedback stored its ref).
    fake_memory.deref_results[fb1["record_id"]] = RecalledEvidence(
        entry_id=fb1["record_id"],
        reference_id=fb1["record_id"],
        score=1.0,
        knowledge_confidence=1.0,
        is_stale=False,
        content="",
        record=first_written,
    )

    rec2 = _recommend_haiku(client, fake_memory)
    fb2 = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec2["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "failure",
            "quality_score": 0.1,
            "evidence_source": "judge",
            "actual_cost_usd": 0.003,
            "output_tokens": 700,
        },
    ).json()
    assert fb2["accepted"] is True
    second_written = fake_memory.remembered[1]["record"]
    assert second_written.n_outcomes == 2
    assert abs(second_written.success_mass - 1.0) < 1e-9  # 0.9 + 0.1
    assert second_written.cost_samples == [0.002, 0.003]
    assert second_written.output_token_samples == [500, 700]
    # One failure no longer erases the prior success — it's one unit of history.
    assert second_written.outcome == "failure"


def test_duplicate_feedback_is_ignored(client, fake_memory):
    """Replaying the same recommendation_id must not double-count history."""
    from minima.memory.records import RecalledEvidence

    rec = _recommend_haiku(client, fake_memory)
    body = {
        "recommendation_id": rec["recommendation_id"],
        "chosen_model_id": "claude-haiku-4-5",
        "outcome": "success",
        "quality_score": 0.9,
        "evidence_source": "judge",
        "actual_cost_usd": 0.002,
    }
    fb1 = client.post("/v1/feedback", json=body).json()
    assert fb1["accepted"] is True
    written = fake_memory.remembered[0]["record"]
    fake_memory.deref_results[fb1["record_id"]] = RecalledEvidence(
        entry_id=fb1["record_id"],
        reference_id=fb1["record_id"],
        score=1.0,
        knowledge_confidence=1.0,
        is_stale=False,
        content="",
        record=written,
    )

    fb2 = client.post("/v1/feedback", json=body).json()
    assert fb2["accepted"] is True
    assert "duplicate_feedback_ignored" in fb2["warnings"]
    assert len(fake_memory.remembered) == 1  # no second write
    assert len(fake_memory.outcomes) == 1  # no second reinforcement


def test_recall_query_uses_the_stored_gist_representation(client, fake_memory):
    """Phase 1b: recall queries with the same '[type/difficulty] gist' text that
    outcome records were embedded with at write time — not the raw prompt."""
    _recommend_haiku(client, fake_memory)
    query = fake_memory.recall_calls[0]["query"]
    assert query.startswith("[code/hard] ")


def test_degraded_keyed_lookup_is_surfaced(client, fake_memory):
    """A dead lookup channel (timeout/policy) must warn, never silently thin evidence."""
    fake_memory.lookup_results = None  # simulate policy rejection / timeout
    rec = _recommend_haiku(client, fake_memory)
    assert "keyed_lookup_degraded" in rec["warnings"]


def test_drift_signals_surface_as_warnings(client, fake_memory):
    """Mubit DriftMonitor flags on the recall response ride out as diagnostics."""
    fake_memory.recall_result_overrides = {"drift_repeated": True, "drift_stagnant": True}
    rec = _recommend_haiku(client, fake_memory)
    assert "memory_drift:repeated" in rec["warnings"]
    assert "memory_drift:stagnant" in rec["warnings"]


def test_no_drift_signals_no_drift_warnings(client, fake_memory):
    rec = _recommend_haiku(client, fake_memory)
    assert not [w for w in rec["warnings"] if w.startswith("memory_drift")]


def test_chosen_effort_is_recorded(client, fake_memory):
    """(model x effort) raw material: the effort tier rides the wire into the record."""
    rec = _recommend_haiku(client, fake_memory)
    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
            "evidence_source": "judge",
            "chosen_effort": "medium",
        },
    ).json()
    assert fb["accepted"] is True
    assert fake_memory.remembered[0]["record"].effort == "medium"


def test_judge_source_cannot_claim_verified_in_production(client, fake_memory):
    """verified_in_production is derived from provenance (source == gate) — a caller
    combining judge provenance with the legacy vip flag must not mint gate trust."""
    rec = _recommend_haiku(client, fake_memory)

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.95,
            "evidence_source": "judge",
            "verified_in_production": True,
        },
    ).json()

    assert fb["accepted"] is True
    written = fake_memory.remembered[0]["record"]
    assert written.evidence_source == "judge"
    assert written.verified_in_production is False
    assert written.quality_score == 0.95
    assert fb["lesson_promoted"] is False


def test_recall_votes_land_on_recalled_durable_records(client, fake_memory):
    """Recall-track: a trusted-label outcome casts one vote per recalled durable record
    (dereference -> fold -> upsert), skipping the record the feedback itself upserted."""
    from minima.memory.records import OutcomeRecord

    rec = _recommend_haiku(client, fake_memory)
    durable = OutcomeRecord(
        model_id="claude-haiku-4-5",
        task_type="code",
        difficulty="hard",
        task_cluster="code:hard",
        outcome="success",
        quality_score=0.9,
        evidence_source="judge",
        n_outcomes=3,
        success_mass=2.5,
    )
    fake_memory.deref_results["r1"] = make_evidence(
        "claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"
    )
    fake_memory.deref_results["r1"].record = durable

    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "failure",
            "quality_score": 0.1,
            "evidence_source": "judge",
        },
    ).json()
    assert fb["accepted"] is True

    votes = [w for w in fake_memory.remembered if w["idempotency_key"].startswith("rv:")]
    assert len(votes) == 1
    voted = votes[0]["record"]
    assert (voted.recall_n, voted.recall_success_mass) == (1, 0.0)
    assert voted.invalidated_at is None  # one bad vote is not a collapse
    # The direct observation history is untouched by the vote.
    assert (voted.n_outcomes, voted.success_mass) == (3, 2.5)
    assert votes[0]["upsert_key"] == "minima:om:code:hard:claude-haiku-4-5"


def test_recall_vote_collapse_stamps_invalidation(client, fake_memory):
    """The vote that drops a record's recall rate below the threshold (min_n=5,
    rate<0.2) stamps invalidated_at — bi-temporal tombstone, never a delete."""
    from minima.memory.records import OutcomeRecord

    rec = _recommend_haiku(client, fake_memory)
    doomed = OutcomeRecord(
        model_id="claude-haiku-4-5",
        task_type="code",
        difficulty="hard",
        task_cluster="code:hard",
        outcome="success",
        quality_score=0.9,
        evidence_source="judge",
        recall_n=4,
        recall_success_mass=0.0,
    )
    fake_memory.deref_results["r1"] = make_evidence(
        "claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"
    )
    fake_memory.deref_results["r1"].record = doomed

    client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "failure",
            "quality_score": 0.1,
            "evidence_source": "judge",
        },
    )
    votes = [w for w in fake_memory.remembered if w["idempotency_key"].startswith("rv:")]
    assert len(votes) == 1
    voted = votes[0]["record"]
    assert (voted.recall_n, voted.recall_success_mass) == (5, 0.0)
    assert voted.invalidated_at is not None


def test_partial_outcome_casts_no_recall_votes(client, fake_memory):
    rec = _recommend_haiku(client, fake_memory)
    fake_memory.deref_results["r1"] = make_evidence(
        "claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"
    )
    client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "partial",
            "quality_score": 0.5,
            "evidence_source": "judge",
        },
    )
    votes = [w for w in fake_memory.remembered if w["idempotency_key"].startswith("rv:")]
    assert votes == []


def test_invalidated_evidence_is_skipped_and_warned_at_recommend(client, fake_memory):
    """An invalidated record is out of ranking (aggregation skip) and the recommend
    response says so; the tombstone stays readable in memory."""
    dead = make_evidence("claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1")
    assert dead.record is not None
    dead.record.invalidated_at = 1_700_000_000.0
    live = make_evidence("claude-opus-4-8", 0.9, entry_id="e2", reference_id="r2")
    fake_memory.evidence = [dead, live]

    resp = client.post(
        "/v1/recommend",
        json={
            "task": {"task": "refactor foo", "task_type": "code", "difficulty": "hard"},
            "constraints": {"candidate_models": ["claude-haiku-4-5", "claude-opus-4-8"]},
        },
    ).json()
    assert "recall_invalidated_skipped:1" in resp["warnings"]
    # Only the live record votes: haiku has no usable evidence left.
    basis = {r["model_id"]: r for r in resp["ranked"]}
    opus = basis["claude-opus-4-8"]["predicted_success"]
    haiku = basis["claude-haiku-4-5"]["predicted_success"]
    assert opus >= haiku


def test_step_outcomes_relay_as_process_rewards(client, fake_memory):
    """Per-step gate verdicts ride feedback into Mubit as step outcomes."""
    rec = _recommend_haiku(client, fake_memory)
    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
            "evidence_source": "judge",
            "actual_cost_usd": 0.002,
            "step_outcomes": [
                {"step_id": "s1", "outcome": "success"},
                {"step_id": "s2", "outcome": "failure", "signal": -0.9, "rationale": "gate red"},
            ],
        },
    ).json()
    assert fb["accepted"] is True
    assert fb["step_outcomes_recorded"] == 2
    assert len(fake_memory.step_outcomes) == 2
    derived, explicit = fake_memory.step_outcomes
    assert derived["step_id"] == "s1"
    assert derived["signal"] == 1.0  # derived from the outcome when omitted
    assert derived["metadata"]["recommendation_id"] == rec["recommendation_id"]
    assert explicit["signal"] == -0.9  # caller-supplied signal wins
    assert explicit["rationale"] == "gate red"


def test_step_outcomes_relay_even_when_turn_unlabeled(client, fake_memory):
    """Steps carry their own gate provenance — relayed even on telemetry-only turns."""
    rec = _recommend_haiku(client, fake_memory)
    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "evidence_source": "none",
            "actual_cost_usd": 0.002,
            "step_outcomes": [{"step_id": "s1", "outcome": "success"}],
        },
    ).json()
    assert fb["accepted"] is True
    assert "unlabeled_telemetry_only" in fb["warnings"]
    assert fb["step_outcomes_recorded"] == 1
    assert len(fake_memory.step_outcomes) == 1
    assert len(fake_memory.remembered) == 0  # the turn itself stayed telemetry-only


def test_step_outcomes_capped(client, fake_memory):
    """A runaway harness cannot turn one feedback into hundreds of Mubit writes."""
    rec = _recommend_haiku(client, fake_memory)
    steps = [{"step_id": f"s{i}", "outcome": "success"} for i in range(40)]
    fb = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec["recommendation_id"],
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
            "evidence_source": "judge",
            "step_outcomes": steps,
        },
    ).json()
    assert fb["step_outcomes_recorded"] == 32
    assert "step_outcomes_capped:8" in fb["warnings"]
    assert len(fake_memory.step_outcomes) == 32


def test_duplicate_feedback_skips_step_outcome_replay(client, fake_memory):
    """record_step_outcome has no wire idempotency — the duplicate check is the dedup."""
    rec = _recommend_haiku(client, fake_memory)
    body = {
        "recommendation_id": rec["recommendation_id"],
        "chosen_model_id": "claude-haiku-4-5",
        "outcome": "success",
        "quality_score": 0.9,
        "evidence_source": "judge",
        "step_outcomes": [{"step_id": "s1", "outcome": "success"}],
    }
    fb1 = client.post("/v1/feedback", json=body).json()
    assert fb1["step_outcomes_recorded"] == 1
    written = fake_memory.remembered[0]["record"]
    from minima.memory.records import RecalledEvidence

    fake_memory.deref_results[fb1["record_id"]] = RecalledEvidence(
        entry_id=fb1["record_id"],
        reference_id=fb1["record_id"],
        score=1.0,
        knowledge_confidence=1.0,
        is_stale=False,
        content="",
        record=written,
    )
    fb2 = client.post("/v1/feedback", json=body).json()
    assert "duplicate_feedback_ignored" in fb2["warnings"]
    assert fb2["step_outcomes_recorded"] == 0
    assert len(fake_memory.step_outcomes) == 1  # no replay


def test_corrective_human_feedback_updates_decision_log(client, fake_memory):
    """Telemetry first, the human verdict later: the trusted label corrects the
    decision-log row instead of being dropped by first-write-wins, and the caller
    hears about it via the decision_corrected warning."""
    from tests.conftest import TEST_MUBIT_KEY

    rec = _recommend_haiku(client, fake_memory)
    rec_id = rec["recommendation_id"]

    fb1 = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec_id,
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "evidence_source": "none",
            "actual_cost_usd": 0.002,
            "latency_ms": 900,
        },
    ).json()
    assert fb1["accepted"] is True
    assert "decision_corrected" not in fb1["warnings"]

    fb2 = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec_id,
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "failure",
            "quality_score": 0.1,
            "evidence_source": "human",
        },
    ).json()
    assert fb2["accepted"] is True
    assert "decision_corrected" in fb2["warnings"]

    tenant = client.app.state.passthrough_runtime.resolve(TEST_MUBIT_KEY)
    row = tenant.decision_log.get(rec_id)
    assert row is not None
    assert row.realized_outcome == "failure"
    assert row.realized_quality == 0.1
    assert row.evidence_source == "human"
    assert row.realized_cost_usd == 0.002  # first-reconcile cost kept when omitted
    assert row.realized_latency_ms == 900

    fb3 = client.post(
        "/v1/feedback",
        json={
            "recommendation_id": rec_id,
            "chosen_model_id": "claude-haiku-4-5",
            "outcome": "success",
            "quality_score": 0.9,
            "evidence_source": "judge",
        },
    ).json()
    # Trusted rows stay first-write-wins: no further correction, row unchanged.
    assert "decision_corrected" not in fb3["warnings"]
    row = tenant.decision_log.get(rec_id)
    assert row.realized_outcome == "failure"
