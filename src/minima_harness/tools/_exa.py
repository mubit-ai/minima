"""Internal async client for the Exa web-search API (https://docs.exa.ai).

Shared by the ``web_search`` and ``web_fetch`` tools. Talks to Exa over HTTP with
``httpx`` (matching ``minima.catalog.sources``), validates responses with pydantic, and
classifies failures so callers can react sensibly:

- :class:`ExaAuthError` — bad/missing key (HTTP 401/403). Never retried.
- :class:`ExaTransientError` — network blip or HTTP 429/5xx. Retried with backoff.
- :class:`ExaError` — anything else (bad request, malformed JSON). Not retried.

Every failure surfaces as an :class:`ExaError` (or subclass), so tools catch one type.
The API key is read from ``EXA_API_KEY`` at call time — never hard-coded, never logged.
"""

from __future__ import annotations

import os

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

EXA_BASE_URL = "https://api.exa.ai"


class ExaError(Exception):
    """Base error for all Exa failures."""


class ExaAuthError(ExaError):
    """Authentication failed (missing/invalid key). Not retryable."""


class ExaTransientError(ExaError):
    """Transient failure (network error or HTTP 429/5xx). Retryable."""


class ExaResult(BaseModel):
    """A single search hit or fetched document. Extra fields from Exa are ignored."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    url: str
    id: str = ""
    title: str | None = None
    published_date: str | None = Field(default=None, alias="publishedDate")
    author: str | None = None
    score: float | None = None
    text: str | None = None


class ExaSearchResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    results: list[ExaResult] = Field(default_factory=list)


class ExaContentsResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    results: list[ExaResult] = Field(default_factory=list)


@retry(
    retry=retry_if_exception_type(ExaTransientError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=0.5, max=4),
    reraise=True,
)
async def _post(path: str, payload: dict, *, timeout: float) -> dict:
    """POST ``payload`` to ``{EXA_BASE_URL}{path}`` and return parsed JSON.

    Retries only transient failures (network / 429 / 5xx); auth and other client
    errors surface immediately without retrying.
    """
    key = os.environ.get("EXA_API_KEY")
    if not key:
        raise ExaError("EXA_API_KEY is not set")

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{EXA_BASE_URL}{path}",
                headers={"x-api-key": key, "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.RequestError as exc:
        raise ExaTransientError(f"network error: {exc}") from exc

    if resp.status_code in (401, 403):
        raise ExaAuthError(f"authentication failed (HTTP {resp.status_code})")
    if resp.status_code == 429 or resp.status_code >= 500:
        raise ExaTransientError(f"transient HTTP {resp.status_code}")
    if resp.status_code >= 400:
        raise ExaError(f"HTTP {resp.status_code}: {resp.text[:200]}")

    try:
        return resp.json()
    except ValueError as exc:  # invalid/empty JSON body
        raise ExaError(f"invalid JSON from Exa: {exc}") from exc


async def exa_search(
    query: str, num_results: int = 5, *, timeout: float = 15.0
) -> ExaSearchResponse:
    """Run a web search and return ranked results (titles + URLs, no body text)."""
    data = await _post("/search", {"query": query, "numResults": num_results}, timeout=timeout)
    try:
        return ExaSearchResponse.model_validate(data)
    except ValidationError as exc:
        raise ExaError(f"unexpected Exa /search response: {exc}") from exc


async def exa_contents(
    urls: list[str], *, max_chars: int = 8000, timeout: float = 20.0
) -> ExaContentsResponse:
    """Fetch readable text for one or more URLs (Exa extracts the main content)."""
    text_opt: object = {"maxCharacters": max_chars} if max_chars else True
    data = await _post("/contents", {"urls": urls, "text": text_opt}, timeout=timeout)
    try:
        return ExaContentsResponse.model_validate(data)
    except ValidationError as exc:
        raise ExaError(f"unexpected Exa /contents response: {exc}") from exc
