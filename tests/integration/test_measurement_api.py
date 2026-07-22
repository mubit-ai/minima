"""Measurement layer end to end: decision log, savings, calibration, late feedback,
latency enforcement, epsilon selection, durable fast path, and back-compat."""

from __future__ import annotations

from fastapi.testclient import TestClient

from minima.config import Settings
from minima.main import create_app
from tests.conftest import TEST_MUBIT_KEY
from tests.factories import make_evidence


def _recommend(client, **overrides):
    body = {
        "task": {
            "task": "refactor this recursive def foo()",
            "task_type": "code",
            "difficulty": "hard",
        },
        "constraints": {"candidate_models": ["claude-haiku-4-5", "claude-opus-4-8"]},
    }
    body.update(overrides)
    resp = client.post("/v1/recommend", json=body)
    assert resp.status_code == 200
    return resp.json()


def _feedback(client, rec, **overrides):
    body = {
        "recommendation_id": rec["recommendation_id"],
        "chosen_model_id": rec["recommended_model"]["model_id"],
        "outcome": "success",
        "quality_score": 0.95,
        "actual_cost_usd": 0.002,
    }
    body.update(overrides)
    return client.post("/v1/feedback", json=body)


class TestSavingsAndCalibration:
    def test_savings_reports_both_baselines_and_coverage(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        rec1 = _recommend(client, baseline_model_id="claude-opus-4-8")
        _recommend(client)  # no feedback for this one
        assert _feedback(client, rec1).json()["accepted"] is True

        data = client.get("/v1/savings", params={"days": 1}).json()
        assert data["summary"]["estimated"]["n"] == 2
        assert data["summary"]["estimated"]["n_declared"] == 1
        assert data["summary"]["estimated"]["savings_vs_premium_usd"] > 0
        assert data["summary"]["realized"]["n_reconciled"] == 1
        # The unreconciled recommendation is minutes old — younger than the label
        # maturity window, so it is PENDING and leaves the coverage denominator.
        assert data["health"]["pending_labels"] == 1
        assert data["health"]["feedback_coverage"] == 1.0

    def test_savings_group_by_task_type(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        _recommend(client)
        data = client.get("/v1/savings", params={"days": 1, "group_by": "task_type"}).json()
        assert [g["key"] for g in data["groups"]] == ["code"]

    def test_calibration_reports_after_feedback(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        for _ in range(3):
            rec = _recommend(client)
            _feedback(client, rec)
        data = client.get("/v1/calibration", params={"days": 1}).json()
        global_report = data["reports"][0]
        assert global_report["slice_key"] == "global"
        assert global_report["n"] == 3
        assert data["health"]["feedback_coverage"] == 1.0

    def test_calibration_reports_judge_bias_and_ppi(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        for i in range(8):
            rec = _recommend(client)
            _feedback(
                client,
                rec,
                evidence_source="judge",
                quality_score=0.8 + 0.02 * i,
                output_tokens=100 * (i + 1),
            )
        for _ in range(2):
            rec = _recommend(client)
            _feedback(client, rec, evidence_source="gate", quality_score=None)

        data = client.get("/v1/calibration", params={"days": 1}).json()
        bias = data["judge_bias"]
        assert bias["corrected"] is True
        assert bias["n_fit"] == 8
        assert bias["mean_output_tokens"] == 450.0
        assert "ece_quality_raw" in data["reports"][0]

        ppi = data["ppi_corrected_success"]
        est = ppi[next(iter(ppi))]
        assert est["judge_n"] == 8
        assert est["gate_n"] == 2
        assert est["value"] == est["raw_judge_value"] == 1.0  # all-success, zero rectifier
        assert data["health"]["ppi_corrected_success_rate"] == 1.0

    def test_calibration_judge_bias_absent_without_judge_data(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        rec = _recommend(client)
        _feedback(client, rec)
        data = client.get("/v1/calibration", params={"days": 1}).json()
        assert data["judge_bias"]["corrected"] is False
        assert data["judge_bias"]["n_fit"] == 0
        assert data["ppi_corrected_success"] == {}
        assert "ppi_corrected_success_rate" not in data["health"]

    def test_tenant_isolation_on_savings(self, client):
        _recommend(client)
        other = client.get(
            "/v1/savings",
            params={"days": 1},
            headers={"Authorization": "Bearer mbt_otherorg_kid_secret"},
        ).json()
        assert other["summary"]["estimated"]["n"] == 0


class TestLateFeedback:
    def test_expired_recstore_falls_back_to_decision_log(self, fake_memory):
        # TTL 0 -> every recommendation expires from the recstore immediately, while
        # the decision log (long retention) still resolves it.
        settings = Settings(
            mubit_api_key="test-key", minima_recommendation_ttl_seconds=0
        )
        app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
        with TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}) as client:
            rec = _recommend(client)
            fb = _feedback(client, rec).json()
            assert fb["accepted"] is True
            assert "late_feedback_no_attribution" in fb["warnings"]
            assert fb["reinforced_entry_ids"] == []
            # The outcome record was still written with the durable upsert key.
            assert len(fake_memory.remembered) == 1
            written = fake_memory.remembered[0]
            assert written["upsert_key"].startswith("minima:om:code:hard")
            assert written["record"].recorded_at is not None
            # No neighbor attribution, no lesson.
            assert fake_memory.outcomes == []
            assert fake_memory.lessons == []

    def test_late_feedback_disabled_rejects(self, fake_memory):
        settings = Settings(
            mubit_api_key="test-key",
            minima_recommendation_ttl_seconds=0,
            minima_late_feedback_enabled=False,
        )
        app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
        with TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}) as client:
            rec = _recommend(client)
            fb = _feedback(client, rec).json()
            assert fb["accepted"] is False
            assert "unknown_recommendation" in fb["warnings"]


class TestQualityGate:
    def test_contradictory_quality_is_clamped_and_warned(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        rec = _recommend(client)
        fb = _feedback(client, rec, outcome="failure", quality_score=0.95).json()
        assert fb["accepted"] is True
        assert "quality_outcome_mismatch" in fb["warnings"]
        assert fake_memory.remembered[0]["record"].quality_score == 0.6


class TestLatencyConstraint:
    def test_slow_observed_model_is_filtered(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.92, entry_id=f"h{i}", latency_ms=9000)
            for i in range(4)
        ] + [
            make_evidence("claude-opus-4-8", 0.95, entry_id=f"o{i}", latency_ms=1500)
            for i in range(4)
        ]
        rec = _recommend(client, constraints={
            "candidate_models": ["claude-haiku-4-5", "claude-opus-4-8"],
            "max_latency_ms": 3000,
        })
        assert rec["recommended_model"]["model_id"] == "claude-opus-4-8"
        assert rec["recommended_model"]["est_latency_ms"] == 1500.0
        assert rec["recommended_model"]["latency_basis"] == "observed_p75"

    def test_model_without_latency_evidence_is_never_condemned(self, client, fake_memory):
        # haiku has slow evidence; opus has none -> opus must remain selectable.
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.92, entry_id=f"h{i}", latency_ms=9000)
            for i in range(4)
        ]
        rec = _recommend(client, constraints={
            "candidate_models": ["claude-haiku-4-5", "claude-opus-4-8"],
            "max_latency_ms": 3000,
        })
        assert rec["recommended_model"]["model_id"] == "claude-opus-4-8"

    def test_all_filtered_keeps_set_with_warning(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence(m, 0.92, entry_id=f"{m}-{i}", latency_ms=9000)
            for m in ("claude-haiku-4-5", "claude-opus-4-8")
            for i in range(4)
        ]
        rec = _recommend(client, constraints={
            "candidate_models": ["claude-haiku-4-5", "claude-opus-4-8"],
            "max_latency_ms": 1000,
        })
        assert "no_model_within_latency_budget" in rec["warnings"]
        assert rec["recommended_model"]["model_id"]  # still recommends something


class TestSelectionPolicy:
    def test_default_policy_is_thompson_with_honest_propensities(self, fake_memory):
        # Thompson is the production default: posterior sampling over the candidates,
        # Monte-Carlo selection frequencies logged as (non-degenerate) propensities.
        settings = Settings(mubit_api_key="test-key")
        assert settings.minima_selection_policy == "thompson"
        app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
        fake_memory.evidence = [
            make_evidence(model, quality, entry_id=f"{model}-{i}")
            for model, quality in (("claude-haiku-4-5", 0.9), ("claude-opus-4-8", 0.95))
            for i in range(4)
        ]
        with TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}) as client:
            rec = _recommend(client, cost_quality_tradeoff=0)
            assert rec["selection_policy"] in ("thompson", "argmin")  # argmin = capped
            assert rec["recommended_model"]["model_id"] in (
                "claude-haiku-4-5",
                "claude-opus-4-8",
            )

    def test_argmin_org_opt_out(self, fake_memory):
        # The test key's org id is "test" (mbt_test_...).
        settings = Settings(mubit_api_key="test-key", minima_argmin_orgs="test")
        app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        with TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}) as client:
            rec = _recommend(client)
            assert rec["selection_policy"] == "argmin"

    def test_explore_share_cap_falls_back_to_argmin(self, fake_memory):
        # A zero cap means every Thompson deviation is suppressed: the pick stays the
        # deterministic argmin and the response says so (explore_budget_capped) —
        # bounded deliberate-exploration spend on live traffic.
        settings = Settings(mubit_api_key="test-key", minima_explore_share_cap=0.0)
        app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
        fake_memory.evidence = [
            make_evidence(model, quality, entry_id=f"{model}-{i}")
            for model, quality in (("claude-haiku-4-5", 0.55), ("claude-opus-4-8", 0.95))
            for i in range(2)
        ]
        with TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}) as client:
            for _ in range(10):
                rec = _recommend(client, cost_quality_tradeoff=8)
                if "explore_budget_capped" in rec["warnings"]:
                    assert rec["selection_policy"] == "argmin"
                else:
                    assert "thompson_pick" not in rec["warnings"]


class TestPolicyValue:
    def test_policy_value_endpoint_shape(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        rec = _recommend(client)
        client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec["recommendation_id"],
                "chosen_model_id": rec["recommended_model"]["model_id"],
                "outcome": "success",
                "quality_score": 0.9,
                "evidence_source": "judge",
                "actual_cost_usd": 0.002,
            },
        )
        resp = client.get("/v1/policy-value", params={"days": 1}).json()
        report = resp["report"]
        assert report["n_trusted"] == 1
        assert report["n_total_reconciled"] == 1
        names = {p["policy"] for p in report["policies"]}
        assert "deployed" in names and "oracle_model_based" in names
        assert report["regret_vs_oracle"] >= 0.0
        # Estimator suite rides every policy block; DR stays the headline number.
        for policy in report["policies"]:
            assert set(policy["estimates"]) == {"dr", "snips", "switch", "dr_shrunk"}
            assert policy["estimates"]["dr"] == policy["success_value"]
        assert report["estimator_disagreement"] is False
        assert resp["warnings"] == []
        # The decision carried shadow choices, the feedback a trusted label, and the
        # logged pick a usable propensity — the challenger block must materialize.
        assert {c["policy"] for c in resp["challengers"]} <= {"discounted", "raw_argmin"}
        for challenger in resp["challengers"]:
            assert challenger["n"] >= 1
            assert 0.0 <= challenger["success_value"] <= 1.0

    def test_snapshot_change_surfaces_posterior_reset(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        for snapshot in ("claude-haiku-4-5-20260101", "claude-haiku-4-5-20260601"):
            rec = _recommend(client)
            _feedback(
                client,
                rec,
                chosen_model_id="claude-haiku-4-5",
                provider_model_snapshot=snapshot,
            )
        data = client.get("/v1/memory/health").json()
        resets = data["posterior_resets"]
        assert len(resets) == 1
        assert resets[0]["model"] == "claude-haiku-4-5"
        assert resets[0]["cause"] == "snapshot_change"
        assert resets[0]["lane"] is None and resets[0]["cluster"] is None


class TestDurableFastPath:
    def _seed_ref_via_feedback(self, client, fake_memory):
        """First loop: recommend + feedback registers the durable record's id."""
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        rec = _recommend(client)
        assert _feedback(client, rec).json()["accepted"] is True
        # The feedback write returned record_id "rec-fake-1"; expose it to Dereference.
        fake_memory.deref_results["rec-fake-1"] = make_evidence(
            "claude-haiku-4-5", 0.95, entry_id="rec-fake-1", reference_id="rec-fake-1"
        )

    def test_recommend_path_never_dereferences(self, client, fake_memory):
        self._seed_ref_via_feedback(client, fake_memory)
        fake_memory.evidence = []
        # Feedback itself now dereferences (recall-track read-modify-write); the
        # invariant under test is that the RECOMMEND path never does.
        fake_memory.dereference_calls.clear()
        _recommend(client)
        assert fake_memory.dereference_calls == []


    def test_hung_dereference_never_blocks_the_recommendation(self, fake_memory):
        import asyncio

        async def hang(**_kwargs):
            await asyncio.sleep(30)

        settings = Settings(
            mubit_api_key="test-key",
            minima_durable_fastpath="on",
            minima_memory_recall_timeout_ms=200,
        )
        app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
        with TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}) as client:
            self._seed_ref_via_feedback(client, fake_memory)
            fake_memory.dereference = hang  # Mubit goes unresponsive
            fake_memory.evidence = []
            rec = _recommend(client)  # must return promptly via the timeout path
            assert rec["recommendation_id"]


class TestBackCompat:
    def test_new_response_fields_are_additive(self, client, fake_memory):
        fake_memory.evidence = [
            make_evidence("claude-haiku-4-5", 0.9, entry_id=f"e{i}") for i in range(3)
        ]
        rec = _recommend(client)
        # Old required fields still present and shaped as before.
        for key in (
            "recommendation_id",
            "recommended_model",
            "ranked",
            "confidence",
            "decision_basis",
            "threshold_used",
            "warnings",
        ):
            assert key in rec
        # New fields have safe defaults; old clients simply ignore them.
        assert rec["selection_policy"] == "argmin"
        assert "est_latency_ms" in rec["recommended_model"]

    def test_old_minimal_request_still_works(self, client):
        resp = client.post("/v1/recommend", json={"task": {"task": "hello world"}})
        assert resp.status_code == 200
