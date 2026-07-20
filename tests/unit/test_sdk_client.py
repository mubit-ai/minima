"""SDK client surface: headers, typed feedback, retries, error subtypes, new endpoints."""

from __future__ import annotations

import httpx
import pytest
import respx
from minima_client.client import AsyncMinimaClient, MinimaClient
from minima_client.errors import MinimaError, MinimaRateLimited, MinimaUnavailable

BASE = "http://minima.test"

_CAPS = {"plan": False, "workflow": True, "api_version": "0.12.0", "honored_constraints": []}
_FEEDBACK_OK = {"accepted": True, "recommendation_id": "rec-1", "warnings": []}


@respx.mock
def test_version_and_user_agent_headers_sent():
    route = respx.get(f"{BASE}/v1/health").mock(return_value=httpx.Response(200, json={"ok": 1}))
    with MinimaClient(BASE) as client:
        client.health()
    sent = route.calls.last.request.headers
    assert sent["x-minima-client"]
    assert sent["user-agent"].startswith("minima-cli/")


@respx.mock
def test_capabilities_and_policy_value():
    respx.get(f"{BASE}/v1/capabilities").mock(return_value=httpx.Response(200, json=_CAPS))
    policy = respx.get(f"{BASE}/v1/policy-value").mock(
        return_value=httpx.Response(
            200,
            json={
                "org_id": "org",
                "since": 0.0,
                "days": 7.0,
                "namespace": "team-a",
                "report": {
                    "n_trusted": 0,
                    "n_total_reconciled": 0,
                    "stochastic_share": 0.0,
                    "policies": [],
                    "regret_vs_oracle": 0.0,
                },
            },
        )
    )
    with MinimaClient(BASE) as client:
        caps = client.capabilities()
        assert caps.workflow is True
        report = client.policy_value(namespace="team-a", days=7)
    assert report.report.n_trusted == 0
    assert policy.calls.last.request.url.params["namespace"] == "team-a"


@respx.mock
def test_feedback_typed_params_land_on_the_wire():
    route = respx.post(f"{BASE}/v1/feedback").mock(
        return_value=httpx.Response(200, json=_FEEDBACK_OK)
    )
    with MinimaClient(BASE) as client:
        client.feedback(
            "rec-1",
            "m",
            "partial",
            quality_score=0.5,
            evidence_source="judge",
            chosen_effort="high",
            iterations=3,
        )
    import json

    body = json.loads(route.calls.last.request.content)
    assert body["quality_score"] == 0.5
    assert body["evidence_source"] == "judge"
    assert body["chosen_effort"] == "high"
    assert body["iterations"] == 3


@respx.mock
def test_feedback_retries_on_unavailable_then_succeeds():
    route = respx.post(f"{BASE}/v1/feedback")
    route.side_effect = [
        httpx.Response(503, json={"detail": "upstream"}),
        httpx.Response(200, json=_FEEDBACK_OK),
    ]
    with MinimaClient(BASE) as client:
        resp = client.feedback("rec-1", "m", "success")
    assert resp.accepted is True
    assert route.call_count == 2


@respx.mock
def test_feedback_does_not_retry_client_errors():
    route = respx.post(f"{BASE}/v1/feedback").mock(
        return_value=httpx.Response(422, json={"detail": "bad"})
    )
    with MinimaClient(BASE) as client, pytest.raises(MinimaError):
        client.feedback("rec-1", "m", "success")
    assert route.call_count == 1


@respx.mock
def test_recommend_does_not_retry():
    route = respx.post(f"{BASE}/v1/recommend").mock(
        return_value=httpx.Response(503, json={"detail": "upstream"})
    )
    with MinimaClient(BASE) as client, pytest.raises(MinimaUnavailable):
        client.recommend("do a thing")
    assert route.call_count == 1


@respx.mock
def test_rate_limited_carries_retry_after():
    respx.get(f"{BASE}/v1/health").mock(
        return_value=httpx.Response(429, json={"detail": "slow down"}, headers={"retry-after": "7"})
    )
    with MinimaClient(BASE) as client, pytest.raises(MinimaRateLimited) as exc:
        client.health()
    assert exc.value.retry_after == 7.0


@respx.mock
def test_recommend_phase_and_incumbent_on_the_wire():
    route = respx.post(f"{BASE}/v1/recommend").mock(
        return_value=httpx.Response(422, json={"detail": "shape check only"})
    )
    with MinimaClient(BASE) as client, pytest.raises(MinimaError):
        client.recommend(
            "route me",
            phase="interactive",
            incumbent_model_id="claude-haiku-4-5",
            max_candidates=4,
        )
    import json

    body = json.loads(route.calls.last.request.content)
    assert body["task"]["tags"] == ["phase:interactive"]
    assert body["incumbent_model_id"] == "claude-haiku-4-5"
    assert body["max_candidates"] == 4


@respx.mock
async def test_async_feedback_retries_on_transport_error():
    route = respx.post(f"{BASE}/v1/feedback")
    route.side_effect = [
        httpx.ConnectError("boom"),
        httpx.Response(200, json=_FEEDBACK_OK),
    ]
    async with AsyncMinimaClient(BASE) as client:
        resp = await client.feedback("rec-1", "m", "success")
    assert resp.accepted is True
    assert route.call_count == 2
