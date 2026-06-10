# syntax=docker/dockerfile:1
# ── builder ───────────────────────────────────────────────────────────────────
# uv's official image ships uv + Python 3.13 together.
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS builder

WORKDIR /build

# Install dependencies in a separate layer so source changes don't bust the cache.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Copy source, then install the project itself.
COPY src/minima/       ./src/minima/
COPY client_sdk/minima_client/ ./client_sdk/minima_client/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM python:3.13-slim

WORKDIR /app

# Non-root user for defence-in-depth.
RUN addgroup --system minima && adduser --system --ingroup minima --no-create-home minima

COPY --from=builder --chown=minima:minima /build/.venv        /app/.venv
COPY --from=builder --chown=minima:minima /build/src          /app/src
COPY --from=builder --chown=minima:minima /build/client_sdk   /app/client_sdk

USER minima

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Cloud Run injects PORT (default 8080). One uvicorn worker per container;
# Cloud Run handles horizontal scaling at the instance level.
CMD ["sh", "-c", "exec uvicorn minima.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]
