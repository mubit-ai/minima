from __future__ import annotations

import os
import sys

import anyio
import httpx
from pydantic import BaseModel, ConfigDict, Field


class ExaResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    title: str | None = None
    url: str
    id: str
    published_date: str | None = Field(default=None, alias="publishedDate")
    text: str | None = None


class ExaSearchResponse(BaseModel):
    results: list[ExaResult]


class ExaFetchResponse(BaseModel):
    results: list[ExaResult]


async def exa_search(query: str, num_results: int = 5, timeout: float = 15.0) -> ExaSearchResponse:
    key = os.environ["EXA_API_KEY"]
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            "https://api.exa.ai/search",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            json={"query": query, "numResults": num_results},
        )
        resp.raise_for_status()
        return ExaSearchResponse.model_validate(resp.json())


async def amain() -> None:
    query = " ".join(sys.argv[1:]) or "retrieval augmented generation"
    data = await exa_search(query)
    if not data.results:
        print("No results.")
        return
    for i, r in enumerate(data.results, 1):
        print(f"[{i}] {r.title or '(no title)'}\n    {r.url}")


if __name__ == "__main__":
    anyio.run(amain)
