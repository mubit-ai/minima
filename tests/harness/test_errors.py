"""classify_provider_error: raw provider failures -> short, actionable, provider-aware text."""

from __future__ import annotations

from minima_harness.ai.errors import classify_provider_error


def test_auth_error_names_provider_and_key_var():
    msg = classify_provider_error(
        "Client error '401 Unauthorized' for url 'https://api.anthropic.com/v1/messages'",
        "claude-opus-4-8",
    )
    assert "Authentication failed" in msg
    assert "Anthropic" in msg  # display name from the catalog
    assert "ANTHROPIC_API_KEY" in msg  # the env var the user must set


def test_no_api_key_message_classified_as_auth():
    # google-genai raises "No API key was provided" — should read as an auth problem.
    msg = classify_provider_error("ValueError: No API key was provided.", "gemini-2.5-pro")
    assert "Authentication failed" in msg
    assert "GEMINI_API_KEY" in msg


def test_model_not_found_is_404():
    msg = classify_provider_error("Error 404: model not found", "gpt-4o")
    assert "doesn't recognize" in msg
    assert "gpt-4o" in msg


def test_rate_limit_is_429():
    msg = classify_provider_error("429 Too Many Requests: rate limit exceeded", "gpt-4o")
    assert "rate-limited" in msg


def test_forbidden_403_is_actionable():
    # The Gemini case the user hit: 403 can be a key-permission OR a quota problem, so the
    # message must offer both fixes (check the key, or pin another model).
    msg = classify_provider_error("Client error '403 Forbidden'", "gemini-2.5-flash")
    assert "Access denied" in msg and "Gemini" in msg
    assert "GEMINI_API_KEY" in msg and "/config" in msg
    assert "/model" in msg  # the universal escape hatch when one provider is unavailable


def test_connection_error():
    msg = classify_provider_error("ConnectError: failed to connect", "claude-haiku-4-5")
    assert "Couldn't reach" in msg


def test_unknown_error_falls_back_to_first_line():
    msg = classify_provider_error("weird teapot failure\nsecond line", "gpt-4o")
    assert "weird teapot failure" in msg
    assert "second line" not in msg  # only the first line


def test_unknown_model_id_degrades_gracefully():
    # Not in the registry -> generic provider phrasing, never a crash.
    msg = classify_provider_error("401 unauthorized", "some-unregistered-model")
    assert "Authentication failed" in msg
    assert msg  # non-empty


def test_none_inputs_do_not_crash():
    msg = classify_provider_error(None, None)
    assert msg  # returns *some* message
