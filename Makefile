.PHONY: install run test test-backends lint fmt live eval seed refresh-catalog harness-demo harness-live harness-test harness

install:
	uv sync --extra dev   # dev pulls server + harness + tui for the full test suite

run:
	uv run --extra server uvicorn minima.main:app --reload --host $${MINIMA_HOST:-0.0.0.0} --port $${MINIMA_PORT:-8080}

test:
	uv run pytest -m "not live and not eval and not backends" -q

test-backends:
	uv run pytest tests/unit/test_store_backends.py -v

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

# --- minima_harness convenience targets (creds live in gitignored .env.harness) ---

harness-demo:
	uv run python examples/harness_warmup.py

harness-live:
	uv run --env-file .env.harness python examples/harness_warmup.py --live --rounds $${ROUNDS:-1}

harness-test:
	uv run --env-file .env.harness pytest tests/harness -m live -v

harness:
	uv run --extra harness --extra tui --env-file .env.harness minima-harness $(ARGS)
