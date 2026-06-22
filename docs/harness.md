# Agent Harness (`minima_harness`)

A lean Python port of [`@earendil-works/pi`](https://github.com/earendil-works/pi)'s
agent toolkit (`pi-ai` + `pi-agent-core`), made **Minima-native**: every prompt is routed
through Minima, and every realized outcome (tokens / cost / latency / quality) is fed
back so Minima's memory sharpens. It lives alongside the Minima service in this repo at
[`src/minima_harness/`](../src/minima_harness/) and ships in the same wheel.

> The port is a from-scratch reimplementation of PI's design and APIs (no source copied);
> see `src/minima_harness/LICENSE_PI` for MIT attribution. The Minima integration layer is
> original work.

## The loop

```
MinimaAgent.prompt(task)
   │
   ├─ 1. ROUTE   ── MinimaRouter.recommend() ──▶ POST /v1/recommend
   │                sets agent.state.model (mapped from Minima's RankedModel)
   │
   ├─ 2. RUN     ── Agent loop (ported pi-agent-core)
   │                streams the model, executes tools, may run several turns
   │
   └─ 3. FEED BACK ─ MinimaRouter.feedback() ──▶ POST /v1/feedback
                     realized input_tokens / output_tokens / actual_cost_usd /
                     latency_ms + judged quality  ➜ outcome ∈ {success, partial, failure}
```

Minima never runs the model — the harness owns model dispatch (via the ported `ai`
provider layer) and quality judging. Routing is **bypassable**: if Minima is unreachable
and `allow_offline=True`, the run proceeds on the current model with no feedback.

## Architecture

```
src/minima_harness/
├── ai/                 ported pi-ai: unified multi-provider LLM API
│   ├── types.py          Model · Context · Message · ContentBlock · AssistantMessage · Usage
│   ├── registry.py       get_model/get_models/get_providers + seed catalog
│   ├── stream.py         stream() / complete()  (+ Stream wrapper with .result())
│   ├── tools.py          Tool + validate_tool_call  (pydantic params)
│   ├── usage.py          realized cost = tokens × model.price
│   ├── compat.py         cross-provider: foreign thinking → <thinking> text tags
│   └── providers/        base Protocol + faux (tests) · anthropic · google · openai_compat(httpx)
├── agent/              ported pi-agent-core: stateful agent runtime
│   ├── events.py         agent_start/end · turn_* · message_* · tool_execution_*
│   ├── tools.py          AgentTool · ToolResult · before/afterToolCall hooks
│   ├── state.py          AgentState + AgentLoopConfig
│   ├── loop.py           agent_loop async generator + tool execution (parallel via anyio)
│   └── agent.py          Agent: prompt/continue_/abort/wait_for_idle/subscribe/steer/follow_up
├── minima/             the Minima-native layer (original work)
│   ├── config.py         HarnessConfig (MINIMA_URL, candidates, namespace, judge policy)
│   ├── mapping.py        RankedModel → harness Model (tolerant: exact → id → provider/model)
│   ├── judge.py          QualityJudge Protocol · LLMJudge · DeterministicJudge · ConstJudge
│   ├── router.py         MinimaRouter: recommend → RoutingResult, feedback (realized cost)
│   └── runtime.py        MinimaAgent(Agent): route → run → judge → feedback per prompt
└── tasks/              task corpus + grade_outcome thresholds
    └── task_set.py        Task dataclass + sample tasks (absorbed from agent/task_set.py)
```

## Quickstart

### Demo mode (no keys, no services)

```bash
uv run python examples/harness_warmup.py
```

Spins an in-process Minima (`FakeMemory`) + a fake Anthropic provider and runs the task
corpus through `MinimaAgent` end to end. Prints the per-task routing decision, quality,
outcome, realized tokens/cost, and how many outcomes landed in memory.

### Live mode (real Minima + real providers)

```bash
make run                       # Minima on :8080 in another terminal
export MUBIT_API_KEY=...       # passthrough auth on Minima
export ANTHROPIC_API_KEY=...   # for the candidate models you allow
uv run python examples/harness_warmup.py --live --rounds 3
```

### As a library

```python
import asyncio
from minima_harness.minima import HarnessConfig, MinimaAgent
from minima_harness.minima.judge import DeterministicJudge

async def main():
    agent = MinimaAgent(HarnessConfig.from_env())   # MINIMA_URL, MINIMA_API_KEY, candidates…
    # Optional: judge each output with your own scorer instead of the default LLM grader.
    agent.judge = DeterministicJudge(lambda output: 0.9 if "done" in output else 0.2)
    routing = await agent.prompt("Refactor foo() to be async.", task_type="code", slider=7)
    print(routing.chosen_model_id, routing.decision_basis)

asyncio.run(main())
```

## The integration points

**Routing granularity.** One recommend + one feedback per `prompt()`. A multi-turn
tool run uses the routed model throughout; each top-level prompt is one Minima outcome.
Call `prompt()` repeatedly in a conversation and every turn is routed and fed back
independently.

**Realized cost, not Minima's prior.** Feedback sends `actual_cost_usd = usage.cost.total`
computed from the provider's *actual* token counts × the harness registry prices. This is
what lets Minima climb `estimate → observed → rescaled` — its single biggest accuracy
lever. Do not echo Minima's `est_cost_usd` back.

**Quality.** A `QualityJudge` turns the final assistant message into a `[0,1]` score;
`grade_outcome` maps it to `success ≥ 0.8 / partial ≥ 0.4 / failure`. Defaults: `LLMJudge`
(claude-haiku, independent provider) when an Anthropic key is present, else a neutral
`ConstJudge(0.5)`. Pass `DeterministicJudge(your_fn)` for offline/cheap grading, or set
`HarnessConfig(judge_every=0)` to skip judging entirely (neutral `success` outcome, cost
still learned).

**Candidate set + namespace.** `HarnessConfig.candidates` becomes Minima's
`Constraints.candidate_models`; `namespace` isolates memory (lane `minima:<namespace>`).
A fresh namespace = cold memory; use it to keep experiments clean.

**Cost observability (CostMeter).** Hand a `CostMeter` to `MinimaAgent(..., meter=...)`
and it records one row per prompt — model picked, decision basis, est $ / actual $ /
savings-vs-baseline $, turns, quality, outcome — then `meter.report()` renders the table
plus totals (actual vs baseline $, **savings %**, success rate). The data already flowed
to Minima; the meter surfaces it to the human. `baseline_model_id` in `HarnessConfig`
populates each row's "save$" (resolved from the ranked set, no extra round-trip).

**Override / veto (before_route).** Pass an `async (routing, task) -> RoutingResult | None`
hook to inspect or change Minima's pick *before* the model runs: return `None` to accept,
a modified `RoutingResult` to **override** the model/tier, or a result with
`recommendation_id=None` to **veto** (run a different model with no feedback attribution).
This is the explicit, auditable mitigation for routing's "silent quality regression" risk
and the seam for an interactive "Minima picked X for $Y because Z — accept?".

**Code-quality-aware routing (the wedge).** Without signals, `recommend()` sees only the
prompt text, so Minima's recall is text-similarity-based. Pass `files=` to `prompt()` with
a `ContextExtractor` (default: `CodeHealthExtractor`) and the harness computes lightweight
code-health signals — proxy McCabe (decision-keyword count), non-blank LOC, sibling-test
detection, language-agnostic and dependency-free — and feeds them as `tags` /
`difficulty` / `expected_input_tokens` into the recommendation. Routing becomes
*code-aware*: a hard, untested refactor is steered toward a stronger tier than a trivial
extraction. A broken/missing extractor degrades gracefully to text-only routing. The
signal's discrimination (does it actually separate trivial/medium/complex tasks?) is the
falsifiable gate — see `tests/harness/test_signals.py`.

**Token yield (iterations).** The agent loop records `state.turns_taken` per prompt; the
meter shows it and feedback sends it as `iterations` (a new, backward-compatible field on
`FeedbackRequest` / `OutcomeRecord`). This counters the "almost right" retry trap: a cheap
model that takes many turns to resolve can cost more than one frontier turn, and Minima can
now learn *tokens-to-resolution*, not just $/call.

## Extending

- **Add a provider** — implement the `Provider` protocol (`api_id` + async `stream()`
  yielding `Event`s) and `register_provider(api_id, instance())`. Reuse minima's optional
  extras (`anthropic`, `google-genai`); the OpenAI-compatible path uses raw `httpx` (no
  `openai` SDK).
- **Add a tool** — subclass the `AgentTool` shape: a pydantic `parameters` model + an
  async `execute(tool_call_id, params, signal, on_update) -> ToolResult`. The loop
  validates args (errors become tool results the model can retry), runs tools in parallel
  (unless a tool opts into `execution_mode="sequential"`), and honours a `terminate=True`
  hint to skip the follow-up call.
- **Add a judge** — implement `QualityJudge.grade(task, output, *, rubric, expected) ->
  float` and pass it to `MinimaAgent(..., judge=...)`.

## Testing

```bash
uv run pytest tests/harness                 # hermetic (faux provider + FakeMemory + ASGI)
uv run pytest tests/harness -m live         # real providers (skip without keys)
uv run ruff check src/minima_harness && uv run mypy src/minima_harness
```

The faux provider (`minima_harness.ai.providers.register_faux_provider`) gives hermetic
LLM calls; the full Minima round-trip is exercised in-process via `create_app` +
`FakeMemory` + an ASGI transport (see `tests/harness/test_minima_e2e.py`).

## Build roadmap

- **Phases 0–4** — scaffold → ported `pi-ai` (providers + compat) → ported
  `pi-agent-core` (agent loop + tools + hooks) → Minima integration (`MinimaAgent`) →
  example + these docs.
- **Phase A** — cost observability: `RoutingResult` carries Minima's full ranked/rationale/
  warnings payload + `baseline_cost_usd`; `CostMeter`; the `before_route` override/veto hook.
- **Phase B** — code-quality-aware routing: `CodeHealthExtractor` + `ContextExtractor`
  protocol; `tags`/`difficulty`/`expected_input_tokens` flow from touched files into
  `recommend()` via `MinimaAgent.prompt(files=...)`, with a discrimination gate.
- **Phase C** — token yield: `turns_taken` tracked per prompt → `feedback(iterations=)` →
  `FeedbackRequest`/`OutcomeRecord` gain a backward-compatible `iterations` field.

See [`AGENTS.md`](../AGENTS.md) for the per-phase history.
