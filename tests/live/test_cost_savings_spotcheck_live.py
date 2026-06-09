"""Real-model cost spot-check: a cheap model succeeds on easy tasks far cheaper.

This is a provider-reachability spot-check, not a Mubit/costit code path: it calls
``google-genai`` directly with both a cheap and a premium Gemini model on a handful of
deterministically-checkable easy tasks, then asserts the cheap model is essentially as
correct while costing at least 2x less in measured token spend.

    GEMINI_API_KEY=... uv run pytest -m live -k cost_savings_spotcheck -s -q
"""

from __future__ import annotations

import os
import time

import pytest

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not os.getenv("GEMINI_API_KEY"), reason="needs GEMINI_API_KEY"),
]

CHEAP_MODEL = "gemini-2.5-flash"
PREMIUM_MODEL = "gemini-2.5-pro"

# USD per million tokens (input, output).
PRICES: dict[str, tuple[float, float]] = {
    CHEAP_MODEL: (0.30, 2.50),
    PREMIUM_MODEL: (1.25, 10.00),
}

# Each task: a prompt plus a checker over the normalized (lowercased, stripped) answer.
EASY_TASKS: list[tuple[str, str, str]] = [
    (
        "sentiment",
        "Classify the sentiment as exactly one word, positive or negative: "
        "'This product is fantastic, I love it.'",
        "positive",
    ),
    (
        "arithmetic",
        "What is 17 * 23? Reply with only the number.",
        "391",
    ),
    (
        "extraction",
        "Extract only the email address from: Contact us at sales@acme.io for details.",
        "sales@acme.io",
    ),
    (
        "boolean",
        "Is the sky blue on a clear day? Answer yes or no.",
        "yes",
    ),
    (
        "capital",
        "What is the capital of France? Reply with only the city name.",
        "paris",
    ),
    (
        "count",
        "How many days are there in a week? Reply with only the number.",
        "7",
    ),
]


def _normalize(text: str) -> str:
    return (text or "").strip().lower()


def _is_correct(answer: str, expected: str) -> bool:
    """Lenient substring/contains check over normalized text."""
    return _normalize(expected) in _normalize(answer)


def _cost(model: str, prompt_toks: int, out_toks: int) -> float:
    in_price, out_price = PRICES[model]
    return prompt_toks / 1e6 * in_price + out_toks / 1e6 * out_price


def test_cheap_model_is_far_cheaper_on_easy_tasks_live():
    import google.genai as genai

    client = genai.Client(
        api_key=os.environ["GEMINI_API_KEY"], http_options={"timeout": 60000}
    )

    def _ask(model: str, prompt: str) -> tuple[str, float]:
        # Retry transient provider hiccups (504/timeouts are common on heavier models from
        # a cold link); skip only if every attempt fails — that's reachability, not a defect.
        last: Exception | None = None
        for attempt in range(3):
            try:
                resp = client.models.generate_content(model=model, contents=prompt)
                um = resp.usage_metadata
                return resp.text, _cost(
                    model, um.prompt_token_count or 0, um.candidates_token_count or 0
                )
            except Exception as exc:  # noqa: BLE001 — reachability, not a code defect
                last = exc
                time.sleep(2.0 * (attempt + 1))
        pytest.skip(f"Gemini call failed after retries ({model}): {last}")

    cheap_cost = 0.0
    premium_cost = 0.0
    cheap_correct = 0
    premium_correct = 0
    rows: list[tuple[str, bool, bool, float, float]] = []

    for name, prompt, expected in EASY_TASKS:
        cheap_text, c_cost = _ask(CHEAP_MODEL, prompt)
        premium_text, p_cost = _ask(PREMIUM_MODEL, prompt)

        c_ok = _is_correct(cheap_text, expected)
        p_ok = _is_correct(premium_text, expected)

        cheap_cost += c_cost
        premium_cost += p_cost
        cheap_correct += int(c_ok)
        premium_correct += int(p_ok)
        rows.append((name, c_ok, p_ok, c_cost, p_cost))

    n = len(EASY_TASKS)
    print(f"\n{'task':<12} {'cheap_ok':<9} {'prem_ok':<8} {'cheap_$':<12} {'prem_$':<12}")
    print("-" * 56)
    for name, c_ok, p_ok, c_cost, p_cost in rows:
        print(f"{name:<12} {str(c_ok):<9} {str(p_ok):<8} {c_cost:<12.8f} {p_cost:<12.8f}")
    print("-" * 56)
    print(
        f"{'TOTAL':<12} {f'{cheap_correct}/{n}':<9} {f'{premium_correct}/{n}':<8} "
        f"{cheap_cost:<12.8f} {premium_cost:<12.8f}"
    )
    ratio = (cheap_cost / premium_cost) if premium_cost else float("inf")
    print(f"cheap/premium cost ratio: {ratio:.3f} (cheap is {1 / ratio:.2f}x cheaper)")

    # The cheap model handles essentially all of these easy tasks.
    assert cheap_correct >= n - 1, (
        f"cheap model only correct on {cheap_correct}/{n} easy tasks"
    )
    # And it does so at <= half the token spend of the premium model.
    assert premium_cost > 0, "premium model reported zero token cost"
    assert cheap_cost <= 0.5 * premium_cost, (
        f"cheap_cost={cheap_cost:.8f} not <= 0.5 * premium_cost={premium_cost:.8f}"
    )
