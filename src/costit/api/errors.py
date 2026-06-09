"""RFC7807-style problem+json error handlers."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from costit.recommender.engine import NoCandidatesError


class ApiError(Exception):
    """A problem+json error with an explicit status/title (e.g. auth failures)."""

    def __init__(self, status: int, title: str, detail: str):
        self.status = status
        self.title = title
        self.detail = detail
        super().__init__(detail)


def _problem(status: int, title: str, detail: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"type": "about:blank", "title": title, "status": status, "detail": detail},
        media_type="application/problem+json",
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return _problem(exc.status, exc.title, exc.detail)

    @app.exception_handler(NoCandidatesError)
    async def _no_candidates(_request: Request, exc: NoCandidatesError) -> JSONResponse:
        return _problem(422, "No candidate models", str(exc))

    @app.exception_handler(ValueError)
    async def _value_error(_request: Request, exc: ValueError) -> JSONResponse:
        return _problem(400, "Invalid request", str(exc))
