"""Turn a raw provider error into a short, actionable, provider-aware message.

When a provider's HTTP call fails (bad/missing key, model not found, rate limit, network),
the provider swallows the exception into an ``ErrorEvent`` carrying an empty assistant and a
raw ``error_message`` (e.g. ``Client error '401 Unauthorized' for url ...``). That string is
useless to a user. :func:`classify_provider_error` maps it to a one-line explanation that
names the provider and the env var to set — so "other LLMs don't work" becomes
"Authentication failed for Anthropic (claude-opus-4-8) — set ANTHROPIC_API_KEY (/config)".
"""

from __future__ import annotations


def classify_provider_error(raw: str | None, model_id: str | None) -> str:
    """Human-readable, actionable summary of a provider failure.

    ``raw`` is the provider's ``error_message``; ``model_id`` is the model that failed (used
    to name the provider and the key env var). Best-effort: unknown errors fall back to the
    first line of ``raw``.
    """
    from minima_harness.ai.provider_catalog import env_vars_for_provider, spec_for
    from minima_harness.ai.registry import find_model_by_id

    model = find_model_by_id(model_id) if model_id else None
    provider = model.provider if model else ""
    spec = spec_for(provider)
    pname = spec.display_name if spec else (provider or "the provider")
    keyvar = env_vars_for_provider(provider)[0] if provider else ""
    where = f" running {model_id}" if model_id else ""
    low = (raw or "").lower()

    # Client-side request/schema rejection (NOT a provider auth/quota problem). Catch this
    # first: a pydantic ValidationError's "extra_forbidden" / "is not permitted" text would
    # otherwise match the "forbidden"/"permission" branch below and masquerade as a 403. The
    # usual cause is a tool whose JSON schema a given model won't accept.
    schema_hit = (
        "validation error" in low
        or "extra_forbidden" in low
        or "are not permitted" in low
        or "generatecontentconfig" in low
    )
    if schema_hit:
        return (
            f"{pname} rejected the request{where} — a tool's schema isn't accepted by this "
            "model; pin another model (/model) or report it"
        )

    auth_hit = (
        "401" in low
        or "unauthor" in low
        or "invalid_api_key" in low
        or "invalid api key" in low
        or "no api key" in low
        or "missing" in low
        and "key" in low
        or "authentication" in low
    )
    if auth_hit:
        hint = f" — set {keyvar} (/config)" if keyvar else " — check the API key (/config)"
        return f"Authentication failed for {pname}{where}{hint}"
    if "402" in low or "payment required" in low or "insufficient" in low and "credit" in low:
        return f"{pname} needs credits{where} (402) — top up billing or pick a free/cheaper model"
    if "403" in low or "forbidden" in low or "permission" in low:
        fix = f"check {keyvar} (/config)" if keyvar else "check the API key (/config)"
        return (
            f"Access denied by {pname}{where} (key lacks permission, or no quota) "
            f"— {fix} or pin another model (/model)"
        )
    if "429" in low or "rate limit" in low or "rate_limit" in low or "quota" in low:
        return f"{pname} rate-limited{where} (429) — wait a moment and retry"
    if "404" in low or "not found" in low or "does not exist" in low or "no such model" in low:
        return f"{pname} doesn't recognize {model_id or 'that model'} (404) — pick another model"
    if (
        "connect" in low
        or "timeout" in low
        or "timed out" in low
        or "name or service not known" in low
        or "getaddrinfo" in low
        or "ssl" in low
    ):
        return f"Couldn't reach {pname}{where} — network or endpoint problem"
    first = (raw or "provider error").strip().splitlines()[0] if (raw or "").strip() else ""
    first = first or "provider error"
    return f"{pname} error{where}: {first[:160]}"
