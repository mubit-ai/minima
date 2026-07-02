from pydantic import BaseModel


class ExaResult(BaseModel):
    title: str | None = None
    url: str
    id: str
    published_date: str | None = None  # alias from "publishedDate"
    text: str | None = None


class ExaSearchResponse(BaseModel):
    results: list[ExaResult]
