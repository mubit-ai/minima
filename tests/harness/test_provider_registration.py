"""Provider registration: openai always; anthropic/google when their SDK imports."""

from __future__ import annotations

import pytest

from minima_harness.ai.providers import ensure_providers_registered, registered_apis
from minima_harness.ai.providers.base import get_provider


def test_openai_always_registered():
    ensure_providers_registered()
    apis = registered_apis()
    assert "openai-completions" in apis
    # Dispatch must resolve and expose the canonical api_id.
    assert get_provider("openai-completions").api_id == "openai-completions"


@pytest.mark.parametrize("api", ["anthropic-messages", "google-generative-ai"])
def test_optional_providers_registered_when_sdk_present(api: str) -> None:
    ensure_providers_registered()
    try:
        import anthropic  # noqa: F401
        import google.genai  # noqa: F401  # type: ignore[import-not-found]
    except ImportError:
        pytest.skip(f"{api} SDK not installed (install the 'harness' extra)")
    assert api in registered_apis()


def test_get_provider_raises_helpfully_for_unknown():
    ensure_providers_registered()
    with pytest.raises(KeyError, match="no provider registered"):
        get_provider("nope")
