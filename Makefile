.PHONY: install run test lint fmt live eval seed refresh-catalog

install:
	uv sync --extra dev

run:
	uv run uvicorn minima.main:app --reload --host $${MINIMA_HOST:-0.0.0.0} --port $${MINIMA_PORT:-8080}

test:
	uv run pytest -m "not live and not eval" -q

lint:
	uv run ruff check src client_sdk tests
	uv run mypy src/minima

fmt:
	uv run ruff check --fix src client_sdk tests
	uv run ruff format src client_sdk tests

live:
	uv run pytest -m live -q

eval:
	uv run pytest -m eval -q

seed:
	uv run minima-seed --limit $${LIMIT:-2000} --lane $${LANE:-minima:default}
