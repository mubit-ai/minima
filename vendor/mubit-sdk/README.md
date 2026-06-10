# mubit-sdk

Canonical Python SDK for MuBit. Durable memory + continual learning for AI agents.

**Full documentation:** https://docs.mubit.ai

## Install

```bash
pip install mubit-sdk
```

## Quickstart

```python
import os

from mubit import Client

client = Client(
    transport=os.getenv("MUBIT_TRANSPORT", "auto"),
    run_id="sdk-python-demo",
    api_key=os.environ["MUBIT_API_KEY"],
)

client.remember(
    session_id="sdk-python-demo",
    agent_id="sdk-quickstart",
    content="If the replay queue stalls, checkpoint before replaying recovery.",
    intent="lesson",
    lesson_type="success",
    lesson_scope="session",
)

answer = client.recall(
    session_id="sdk-python-demo",
    query="What should I do before replaying recovery?",
    entry_types=["lesson", "rule"],
)
print(answer.get("final_answer"))
```

## Surface model

The SDK exposes two layers:

1. **`mubit.learn`** — zero-config LLM instrumentation (auto-ingest + auto-inject + auto-reflect).
2. **Flat client surface** — every control-plane operation lives directly on `Client`. High-level helpers (`remember`, `recall`, `get_context`, `checkpoint`, `reflect`, `record_outcome`, `record_step_outcome`, `archive`, `dereference`, `memory_health`, `diagnose`, `register_agent`, `list_agents`, `handoff`, `feedback`, `surface_strategies`, `forget`) are richer wrappers that resolve `session_id` and set sensible defaults; all other ops are called as `client.<op>(...)`.

Admin and low-level storage ops still live under `client.auth.*` and `client.core.*` for clarity.

Helper APIs accept `session_id` as the ergonomic alias for `run_id`.

## Managed MuBit resources

For teams and hosted deployments, configure agents declaratively as **Projects** + **Agent Cards** with versioned prompts and skills. See [Projects, Agents, Skills, Prompts](https://docs.mubit.ai/sdk/projects-and-agents) for the full guide.

### Projects

```python
project = client.create_project(
    name="triage-demo",
    description="Customer-support triage pilot",
)
project_id = project["project"]["project_id"]

projects = client.list_projects()
```

### Agent Definitions

```python
agent = client.create_agent_definition(
    project_id=project_id,
    agent_id="triage",
    role="customer triage agent",
    system_prompt_content="You are a concise, empathetic triage agent...",
)
```

### Prompt version lifecycle

Every agent has exactly one `active` prompt version and any number of `candidate` versions awaiting review.

```python
# Manual edit — activates immediately.
client.set_prompt(agent_id="triage", content="...", activate=True)

# Ask the control plane to propose a candidate from recent outcomes.
resp = client.optimize_prompt(agent_id="triage", project_id=project_id)
candidate = resp["candidate"]

# Review the diff, then promote the candidate.
diff = client.get_prompt_diff(
    agent_id="triage",
    version_a_id=active_version_id,
    version_b_id=candidate["version_id"],
)
client.activate_prompt_version(
    agent_id="triage",
    version_id=candidate["version_id"],
)
```

See the [Prompt Optimization Lifecycle](https://docs.mubit.ai/recipes/prompt-optimization) recipe for the full capture → optimize → review → activate workflow.

### Skills

Same shape as prompts — `create_skill`, `optimize_skill`, `activate_skill_version`, `get_skill_diff`.

## Learning loop

```python
client.register_agent(
    session_id="sdk-python-demo",
    agent_id="planner",
    role="planner",
    read_scopes=["rule", "lesson", "fact"],
    write_scopes=["lesson", "trace"],
    shared_memory_lanes=["knowledge", "history"],
)

client.checkpoint(
    session_id="sdk-python-demo",
    label="pre-compaction-1",
    context_snapshot="Planner narrowed the failure to token refresh ordering.",
)

client.record_step_outcome(
    session_id="sdk-python-demo",
    step_id="2026-04-17-route",
    step_name="routing",
    outcome="partial",
    signal=0.3,
    rationale="Routed to billing but should have gone to compliance",
    directive_hint="Check billing AND compliance scopes before routing",
)

strategies = client.surface_strategies(
    session_id="sdk-python-demo",
    lesson_types=["success", "failure"],
    max_strategies=3,
)
```

## Exact references

```python
archived = client.archive(
    session_id="sdk-python-demo",
    artifact_kind="patch_fragment",
    content="--- a/query.py\n+++ b/query.py\n@@ ...",
    labels=["django", "retry"],
    family="patch-repair",
)

exact = client.dereference(
    session_id="sdk-python-demo",
    reference_id=archived["reference_id"],
)
```

## Auto-capture

For zero-friction trace capture in MAS learning loops:

```python
from mubit.auto import instrument, observe

instrument()

@observe(name="repair-attempt")
def run_attempt():
    ...
```

## Endpoint resolution

`transport` defaults to `auto` (gRPC primary, HTTP fallback). Resolution order:

1. Explicit `endpoint` / `http_endpoint` / `grpc_endpoint` constructor args.
2. Env vars `MUBIT_ENDPOINT`, `MUBIT_HTTP_ENDPOINT`, `MUBIT_GRPC_ENDPOINT`.
3. Shared defaults `https://api.mubit.ai` and `grpc.api.mubit.ai:443`.

See [SDK Configuration](https://docs.mubit.ai/sdk/sdk-configuration) for full details.

## Examples

Public adoption scenarios:

```bash
PYTHONPATH=sdk/python/mubit-sdk/src python3 \
  sdk/python/mubit-sdk/examples/public/run_public_examples.py --list

PYTHONPATH=sdk/python/mubit-sdk/src python3 \
  sdk/python/mubit-sdk/examples/public/run_public_examples.py --scenario 01_remember_recall

# End-to-end project + prompt evolution
PYTHONPATH=sdk/python/mubit-sdk/src python3 \
  sdk/python/mubit-sdk/examples/public/run_public_examples.py --scenario 20_e2e_project_prompt_evolution
```

Internal raw-smoke scenarios remain available for wire-level verification:

```bash
PYTHONPATH=sdk/python/mubit-sdk/src python3 \
  sdk/python/mubit-sdk/examples/internal/run_internal_examples.py --list
```

## Related

- **Full documentation:** https://docs.mubit.ai
- **SDK methods reference:** https://docs.mubit.ai/sdk/sdk-methods
- **API reference (HTTP + gRPC):** https://docs.mubit.ai/api-reference/control-http
- **GitHub:** https://github.com/mubit-ai/ricedb
