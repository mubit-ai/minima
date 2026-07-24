# syntax=docker/dockerfile:1
# ── builder ───────────────────────────────────────────────────────────────────
# Use /app as WORKDIR so venv shebangs resolve correctly in the runtime stage.
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS builder

WORKDIR /app

# Install dependencies in a separate layer so source changes don't bust the cache.
# --extra server: the API stack (fastapi/uvicorn/psycopg2/redis) lives in the server extra.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra server --extra classifier --no-install-project

# Copy source, then install the project itself.
COPY README.md         ./
COPY src/minima/       ./src/minima/
COPY client_sdk/minima_client/ ./client_sdk/minima_client/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra server --extra classifier

# ── runtime ───────────────────────────────────────────────────────────────────
FROM python:3.13-slim

WORKDIR /app

# Non-root user for defence-in-depth.
RUN addgroup --system minima && adduser --system --ingroup minima --no-create-home minima

COPY --from=builder --chown=minima:minima /app/.venv        /app/.venv
COPY --from=builder --chown=minima:minima /app/src          /app/src
COPY --from=builder --chown=minima:minima /app/client_sdk   /app/client_sdk

# The trained classifier artifact is baked into the image (no HF download at startup).
# MINIMA_CLASSIFIER_ARTIFACT points at it as an image property; whether it is USED is
# the deploy's call via MINIMA_EMBED_CLASSIFIER / MINIMA_CLASSIFIER_REQUIRED.
COPY --chown=minima:minima models/classifier/ /app/models/classifier/

USER minima

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MINIMA_CLASSIFIER_ARTIFACT="/app/models/classifier/potion-base-32M-c18e819c6c6d"

# Cloud Run injects PORT (default 8080). One uvicorn worker per container;
# Cloud Run handles horizontal scaling at the instance level.
CMD ["sh", "-c", "exec uvicorn minima.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]
