# Python Client SDK

The `costit_client` package is a thin, typed client for the Costit API plus an optional
zero-code intake helper. It ships in the same repo as the server.

```python
from costit_client import CostitClient, AsyncCostitClient, CostitError, autocapture
```

## Clients

Both `CostitClient` (sync) and `AsyncCostitClient` (async) share the same surface.

```python
from costit_client import CostitClient

with CostitClient("http://localhost:8080", api_key=None, timeout=10.0) as costit:
    rec = costit.recommend("Summarize this incident report into 3 bullets.",
                           cost_quality_tradeoff=3)
    print(rec.recommended_model.model_id, rec.est_cost_breakdown if False else "")
```

- `base_url` — the Costit service URL.
- `api_key` — sent as `Authorization: Bearer <key>`. Only needed in multi-tenant mode
  (single-tenant ignores it). `None` to omit.
- `timeout` — HTTP timeout in seconds.

The async client mirrors every method with `await`; use it inside FastAPI/async apps so the
event loop stays unblocked.

```python
async with AsyncCostitClient("http://localhost:8080", api_key="cstk_…") as costit:
    rec = await costit.recommend(task)
```

### `recommend(task, *, ...)`

Returns a `RecommendResponse`.

```python
rec = costit.recommend(
    task,                              # str | TaskInput | dict
    cost_quality_tradeoff=5.0,         # 0..10
    constraints=None,                  # Constraints | None
    user_id=None,
    namespace=None,
    allow_llm_escalation=True,
    explain=True,
)
```

`task` is flexible:

```python
costit.recommend("plain prompt text")                       # str
costit.recommend({"task": "…", "task_type": "code"})        # dict
from costit.schemas.common import TaskInput, Constraints
costit.recommend(TaskInput(task="…", difficulty="hard"),    # TaskInput
                 constraints=Constraints(min_quality=0.85, max_cost_per_call=0.02))
```

### `recommend_workflow(req)`

Takes a `WorkflowRequest`, returns a `WorkflowResponse`.

```python
from costit.schemas.workflow import WorkflowRequest, WorkflowStep
from costit.schemas.common import TaskInput

req = WorkflowRequest(steps=[
    WorkflowStep(step_id="extract", task=TaskInput(task="Extract entities from …",
                                                   task_type="extraction")),
    WorkflowStep(step_id="reason",  task=TaskInput(task="Decide next action given …",
                                                   task_type="reasoning", difficulty="hard")),
], cost_quality_tradeoff=4)
wf = costit.recommend_workflow(req)
print(wf.total_est_cost_usd, "vs", wf.total_est_cost_if_all_premium)
```

### `feedback(recommendation_id, chosen_model_id, outcome, **kwargs)`

Returns a `FeedbackResponse`. `outcome` is `"success" | "partial" | "failure"` (or an
`OutcomeLabel`). Pass realized numbers to power the observed/rescaled cost tiers:

```python
costit.feedback(
    rec.recommendation_id,
    rec.recommended_model.model_id,
    "success",
    quality_score=0.95,
    input_tokens=180, output_tokens=640, actual_cost_usd=0.0034,
    latency_ms=2100,
    verified_in_production=True,
    idempotency_key="…",   # optional
)
```

### `models(...)`, `strategies(...)`, `health()`

```python
catalog = costit.models(provider="anthropic", max_cost=10.0)      # ModelsResponse
strat   = costit.strategies(namespace="team-payments", max_strategies=5)  # StrategiesResponse
status  = costit.health()                                          # dict
```

### Errors

Non-2xx responses raise `CostitError` (which carries the problem+json detail). Catch it
around calls you want to make resilient:

```python
from costit_client import CostitError
try:
    rec = costit.recommend(task)
except CostitError as exc:
    ...  # fall back to a default model
```

## Zero-code intake: `autocapture`

`costit_client.autocapture` is a thin wrapper over `mubit.learn`. Calling `enable()` pins a
learn session to the same memory lane Costit recalls from (`costit:<namespace>`) and
monkeypatches your OpenAI/Anthropic/LiteLLM/Google-GenAI clients, so every LLM call
auto-ingests its trace — no code changes at the call site. Requires `mubit-sdk`.

```python
from costit_client import autocapture

autocapture.enable(api_key="<mubit-key>", endpoint="http://127.0.0.1:3000",
                   namespace="team-payments", user_id="svc-router")

# ... your normal OpenAI/Anthropic/LiteLLM calls happen here, auto-captured ...

# learn does NOT fabricate a success signal — close the loop explicitly:
autocapture.feedback(good=True)        # or score in [-1, 1]
autocapture.disable()                  # restore original client behavior
```

**What it does / doesn't do:** it lands traces + lessons in Costit's lane (enriching the
reasoner's memory block and Mubit's reflection), but it does **not** by itself produce the
`kind="outcome"` records the deterministic k-NN aggregator scores. To fully close the loop,
either call `autocapture.feedback(...)` or send a quality score to `POST /v1/feedback`.

Other helpers: `autocapture.wrap(client)` (enrich one client instead of global patching),
`autocapture.capture(messages, response)` (manual ingest for raw HTTP / unsupported libs).

See [`examples/05_autocapture.py`](../examples/05_autocapture.py).
