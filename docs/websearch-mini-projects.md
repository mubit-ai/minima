# Building Web Search for the Minima Harness — A Mini-Project Guide

> A step-by-step learning path for a junior SWE. Each project is small, self-contained,
> and ends with something you can run and verify. By the end you'll have shipped two new
> agent tools (`web_search` and `web_fetch`) backed by [Exa](https://exa.ai), and you'll
> understand *why* each piece exists.
>
> **Decisions already locked in (so you don't have to re-decide):**
> - **Backend:** Exa (cheaper, simple REST API, what OpenCode uses)
> - **Scope:** two tools — `web_search` (find pages) + `web_fetch` (read a page's text)
> - **Sequencing:** build a working tool first; wire it into Minima routing/feedback later

---

## How to use this guide

Do the projects **in order**. Don't skip ahead — each one assumes the previous works.
Every project has the same shape:

- **Goal** — what you'll have when you're done.
- **Why it matters** — the concept you're really learning.
- **Steps** — concrete actions.
- **Done when** — how you *know* it works (your acceptance test).
- **Stretch** — optional, only if you want more.

If you get stuck, the rule of thumb: **make the smallest thing work end-to-end, then grow it.**
A search that returns one ugly result beats a beautiful design that doesn't run.

---

## Background: how the harness already does tools (read this once)

You're not inventing a plugin system — the harness already has one. Three facts you need:

**1. A tool is a dataclass.** See `src/minima_harness/agent/tools.py`:

```python
@dataclass(slots=True)
class AgentTool:
    name: str                      # what the model calls it
    description: str               # THIS IS A PROMPT — the model reads it to decide when to use the tool
    parameters: type[BaseModel]    # a pydantic model = the tool's argument schema
    execute: ToolExecute           # async (tool_call_id, params, signal, on_update) -> ToolResult
    execution_mode: ... = None
    label: str = ""
```

**2. A tool returns a `ToolResult`.** Its `content` (list of `TextContent`, etc.) is what the
model sees next turn; `details` is for your app, not the model:

```python
@dataclass(slots=True)
class ToolResult:
    content: list[ContentBlock]
    details: dict[str, Any] = field(default_factory=dict)
    terminate: bool = False
```

**3. Look at a real, simple example before writing yours.** `src/minima_harness/tools/bash.py`
is the cleanest template — ~70 lines: a pydantic `BashParams`, an `async def _execute(...)`,
and a `bash_tool()` factory. **Your tools will look almost identical in shape.**

The default coding tools are assembled in `src/minima_harness/tools/builtin.py`
(`default_toolset()`). That's where (or alongside which) you'll register your new tools.

And there's already an async-HTTP convention to copy — `src/minima/catalog/sources/litellm.py`:

```python
async with httpx.AsyncClient(timeout=timeout) as client:
    resp = await client.get(url)
    resp.raise_for_status()
    data = resp.json()
```

`httpx`, `pydantic`, `anyio`, and `tenacity` (retries) are **already dependencies** — you won't
add anything new for the core feature.

---

## Project 0 — Orientation & a single live API call

**Goal:** Get an Exa API key and successfully hit the Exa search API once, from your terminal,
*outside* any of our code.

**Why it matters:** Before you write a line of integration, you must understand the raw
request/response. APIs are just HTTP: a URL, a method, headers (including your secret key),
a JSON body in, a JSON body out. Internalize that shape and the rest is plumbing.

**Steps:**
1. Sign up at <https://exa.ai>, create an API key. Read the docs: <https://docs.exa.ai>.
2. Put the key in your shell **as an environment variable** — never in code, never in git:
   ```bash
   export EXA_API_KEY="exa_..."
   ```
   (Concept to learn: *why* secrets live in env vars / secret managers, not source files.)
3. Make one real call with `curl`:
   ```bash
   curl -s https://api.exa.ai/search \
     -H "x-api-key: $EXA_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"query": "what is retrieval augmented generation", "numResults": 3}' | jq .
   ```
4. Read the JSON. Find `results[].title`, `results[].url`, `results[].id`, `score`,
   `publishedDate`. This is the data your tool will eventually return to the model.

**Done when:** `curl` prints 3 results and you can point at the title/url/snippet fields.

**Stretch:** Try `"type": "neural"` vs `"keyword"` vs `"auto"` and notice how results change.
Also try the `/contents` endpoint with an `id` from your search — that's Project 3's backend.

---

## Project 1 — A standalone async Exa client (no harness yet)

**Goal:** A small Python script, `scratch/exa_search.py`, that calls Exa from async Python,
validates the response with pydantic, and prints clean results. **Not wired into the harness.**

**Why it matters:** You isolate *one* hard thing at a time. Here it's: `async`/`await`,
`httpx.AsyncClient`, parsing untrusted JSON into typed pydantic models, and basic error
handling. If this script is solid, the tool wrapper in Project 2 is trivial.

**Steps:**
1. Define the response shapes with pydantic (mirror Exa's JSON, keep only what you need):
   ```python
   from pydantic import BaseModel

   class ExaResult(BaseModel):
       title: str | None = None
       url: str
       id: str
       published_date: str | None = None  # alias from "publishedDate"
       text: str | None = None

   class ExaSearchResponse(BaseModel):
       results: list[ExaResult]
   ```
   (Concept: pydantic field aliases — Exa sends `publishedDate`; you store `published_date`.
   Look up `Field(alias=...)` + `populate_by_name`.)
2. Write the call, copying the `litellm.py` pattern but with POST + headers:
   ```python
   import os, httpx

   async def exa_search(query: str, num_results: int = 5, timeout: float = 15.0):
       key = os.environ["EXA_API_KEY"]  # raises clearly if missing — good
       async with httpx.AsyncClient(timeout=timeout) as client:
           resp = await client.post(
               "https://api.exa.ai/search",
               headers={"x-api-key": key, "Content-Type": "application/json"},
               json={"query": query, "numResults": num_results},
           )
           resp.raise_for_status()
           return ExaSearchResponse.model_validate(resp.json())
   ```
3. Add a tiny `main()` using `asyncio.run(...)` (or `anyio.run`, to match the repo) that
   prints each result as `[n] title — url`.

**Done when:** `uv run python scratch/exa_search.py "your query"` prints clean, numbered results.

**Stretch:** Handle the three failure modes explicitly and print a friendly message for each:
network error (`httpx.RequestError`), HTTP error (`resp.raise_for_status()` →
`httpx.HTTPStatusError`, e.g. 401 bad key / 429 rate limited), and malformed JSON
(`pydantic.ValidationError`). Knowing *which* failed is half of debugging.

---

## Project 2 — Wrap it as the `web_search` AgentTool

**Goal:** A real tool at `src/minima_harness/tools/web_search.py` that the agent can call.

**Why it matters:** This is the core lesson of the whole guide: **adapting an external
capability to the harness's tool contract.** The model never sees JSON or pydantic — it sees
your `description` (so it knows when to search) and the `content` text you return (so it can
reason over results). Output formatting *is* part of the tool's job.

**Steps:**
1. Create `src/minima_harness/tools/web_search.py`. Mirror `bash.py`'s three parts:
   ```python
   from __future__ import annotations
   from pydantic import BaseModel, Field
   from minima_harness.agent.tools import AgentTool, ToolResult, ToolUpdate, error_result
   from minima_harness.ai.types import TextContent

   class WebSearchParams(BaseModel):
       query: str = Field(description="The search query.")
       num_results: int = Field(default=5, ge=1, le=10)

   async def _execute(tool_call_id, params, signal, on_update: ToolUpdate | None) -> ToolResult:
       assert isinstance(params, WebSearchParams)
       try:
           data = await exa_search(params.query, params.num_results)   # reuse Project 1's logic
       except Exception as exc:                                        # narrow this later (Project 4)
           return error_result(f"web_search failed: {exc}")
       lines = [f"[{i+1}] {r.title or '(no title)'}\n    {r.url}" for i, r in enumerate(data.results)]
       body = "\n".join(lines) if lines else "No results."
       return ToolResult(content=[TextContent(text=body)], details={"count": len(data.results)})

   def web_search_tool() -> AgentTool:
       return AgentTool(
           name="web_search",
           description=(
               "Search the web for current information. Returns a numbered list of "
               "results with titles and URLs. Use this when you need facts you don't "
               "know or that may have changed. To read a result, pass its URL to web_fetch."
           ),
           parameters=WebSearchParams,
           execute=_execute,
       )
   ```
2. **Move Project 1's `exa_search` into the codebase** — e.g. a small internal module like
   `src/minima_harness/tools/_exa.py` (the leading underscore matches `_io.py` in that dir,
   signalling "internal helper"). Both tools will share it.
3. Register it. Either add to `default_toolset()` in `builtin.py`, or (cleaner while learning)
   make a custom list where you construct the agent and pass
   `tools=[*default_toolset(), web_search_tool()]`.

**Done when:** You can construct the toolset including `web_search` without import errors, and a
unit-style call to `_execute(...)` with a `WebSearchParams` returns a `ToolResult` whose text
lists results. (You'll run it through the *real* agent loop in Project 6.)

**Note on the `description`:** spend real time here. It's a prompt. Vague descriptions →
the model never calls the tool, or calls it wrong. Compare yours to `bash_tool()`'s wording.

---

## Project 3 — The `web_fetch` tool (read a page)

**Goal:** A second tool, `web_fetch`, that takes a URL and returns clean, readable text — so
the model can actually *read* a result, not just see a snippet.

**Why it matters:** This completes the research loop: the model `web_search`es, picks a URL,
then `web_fetch`es it. You'll also hit a real constraint here: **output size.** A web page can
be huge; the model's context is finite (and tokens cost money). Truncation/extraction is the
lesson.

**Steps:**
1. Use Exa's `/contents` endpoint — it returns extracted text, so you skip HTML parsing:
   ```bash
   curl -s https://api.exa.ai/contents \
     -H "x-api-key: $EXA_API_KEY" -H "Content-Type: application/json" \
     -d '{"urls": ["https://example.com"], "text": true}' | jq .
   ```
   (Exa accepts URLs or result `id`s. Using URLs lets the model fetch anything, not just prior
   search hits.)
2. Add `exa_contents(urls)` to `_exa.py`, same pattern as `exa_search`.
3. Create `src/minima_harness/tools/web_fetch.py` with `WebFetchParams(url: str,
   max_chars: int = 8000)`. **Truncate** the returned text to `max_chars` and append a clear
   marker like `\n\n[truncated — N more chars]` so the model knows it didn't get everything.
4. Write its `description` to say it reads one URL and returns the page's main text.

**Done when:** Fetching a real URL returns readable prose (not HTML tags), and a very long page
comes back truncated with the marker.

**Stretch:** Add an optional `summary` flag using Exa's contents `summary` option, or
`highlights`, and let the model choose full text vs. summary. Discuss the tradeoff: cheaper/
shorter vs. complete.

---

## Project 4 — Make it robust (the "production" project)

**Goal:** The tools fail *gracefully* and behave well under real-world conditions.

**Why it matters:** A demo tool throws stack traces; a real tool returns a useful message the
model (or user) can act on, and survives flaky networks. This is the gap between "works on my
machine once" and "shippable."

**Steps:**
1. **Secrets:** confirm the key only comes from `EXA_API_KEY` (env). If it's missing, return a
   clear `error_result("EXA_API_KEY is not set")` rather than crashing. Add the var to your
   `.env`/docs; never commit it.
2. **Timeouts:** you already pass `timeout=` to `httpx`. Make sure a slow request can't hang the
   agent forever.
3. **Retries:** `tenacity` is already a dependency. Retry only *transient* failures
   (network errors, HTTP 429/5xx) with exponential backoff — **never** retry a 401 (bad key) or
   a 400 (bad request); those won't fix themselves. (Concept: idempotency & which errors are
   retryable.)
4. **Narrow your `except`:** replace the broad `except Exception` from Project 2 with specific
   handling for `httpx.HTTPStatusError`, `httpx.RequestError`, and `pydantic.ValidationError`,
   each returning a distinct, short error message.
5. **Cancellation:** the `signal` parameter exists so a tool can be cancelled (the user hits
   stop). Make sure long fetches respect it — `httpx`'s async client + the agent's task group
   handle most of this; just don't swallow cancellation.

**Done when:** With a *wrong* `EXA_API_KEY` you get a clean "auth failed" message (no traceback);
with the network off you get a clean "network error" message; and a 429 visibly retries then
succeeds or reports rate-limiting.

---

## Project 5 — Tests (lock in the behavior)

**Goal:** Automated tests so future changes can't silently break your tools. **No real network
calls in the default test run.**

**Why it matters:** You learn how to test code that talks to the outside world: you *mock* the
boundary. Tests that hit the live API are slow, flaky, and cost money — so they're opt-in.

**Steps:**
1. Look at how the repo already separates tests (`tests/` has unit/integration/live/eval
   folders, and there's a `faux` provider — `src/minima_harness/ai/providers/faux.py` — for
   exactly this "fake the boundary" idea).
2. **Unit tests** for parsing/formatting: feed canned Exa JSON into your pydantic models and
   into `_execute`, assert the `ToolResult` text. Mock HTTP with `respx` (httpx's mock library)
   or by monkeypatching `exa_search`/`exa_contents`.
3. Test the **error paths** explicitly: 401, 429, malformed JSON, empty results, truncation.
4. (Optional) One **live** test, clearly marked/skipped unless `EXA_API_KEY` is set and a flag
   like `--live` is passed — mirror how the repo gates live tests.

**Done when:** `make test` (or the repo's test command) passes with no network access, covering
the happy path and each error path.

---

## Project 6 — End-to-end in the real agent loop

**Goal:** Run the actual harness/agent with your two tools enabled and watch the model chain
`web_search` → `web_fetch` to answer a question it couldn't answer from memory.

**Why it matters:** Everything before was components. Here you see the **agent loop** do its
thing: the model decides to call a tool, the loop executes it (`src/minima_harness/agent/loop.py`),
feeds the result back, the model reads it and either calls another tool or answers. This is the
payoff — and the best way to feel how `description` quality affects behavior.

**Steps:**
1. Find where the agent/TUI is launched (`src/minima_harness/tui/cli.py` is the `minima` entry
   point) and how a toolset is passed to the agent. Enable your tools there (or via the custom
   toolset from Project 2).
2. Give it a task that *requires* fresh info, e.g. *"What's the latest stable Python release and
   one notable feature? Cite the URL you read."*
3. Watch the events/output. Did it call `web_search`? Then `web_fetch` on a good URL? Did it
   cite the page?
4. If it *didn't* search, your `web_search` description is probably too weak — iterate on it.
   This is a real, common lesson: **tool descriptions are prompt engineering.**

**Done when:** The model autonomously searches, reads a result, and answers with a citation —
without you hand-feeding it URLs.

**Stretch:** Add light logging (the repo uses `structlog`) so you can see each tool call's query,
result count, and latency. Observability makes the next project much easier.

---

## Project 7 — (Phase 2) Wire into Minima routing & feedback

> Only start this once Projects 0–6 are solid and merged. This is the "make it Minima-aware" phase.

**Goal:** Help Minima *route* search-heavy tasks well and *learn* from their outcomes.

**Why it matters:** Minima's whole job is picking a cost-effective model per task and learning
from feedback (route → run → feedback; see `src/minima_harness/minima/runtime.py` and
`router.py`). Web search changes the economics: a search-heavy task burns more tokens (fetched
pages are big) and may need a model that's good at tool use. There are concepts here worth
understanding before you change anything.

**Steps (learn first, then small changes):**
1. **Read the loop:** `runtime.py` (`MinimaAgent.prompt` → recommend / run / feedback),
   `router.py`, and `meter.py` (`CostMeter`). Understand what a "feedback" payload contains.
2. **Tagging:** see how `task_type`/`tags` flow into routing. A task that will use web search is
   a *tool-use* task — tagging it lets Minima prefer models that handle tool use well. Find where
   tags are set and add an appropriate one when search tools are in play.
3. **Cost accounting:** decide whether the Exa API's dollar cost should be visible to the cost
   meter, or whether you only care about token cost. Discuss the tradeoff with your team — this
   is a design decision, not a code detail. Write down what you chose and why.
4. **Feedback signal:** when a search-heavy task succeeds/fails, what should Minima learn? (e.g.
   did the model use the tools effectively?) Start by just making sure existing feedback still
   fires correctly with tools enabled — don't invent new signals on day one.

**Done when:** A search-using task routes, runs with the tools, and reports feedback without
breaking the existing loop — and you can explain, in a paragraph, how adding web search affects
routing decisions.

---

## Cheat sheet — key files you'll touch

| File | What it is |
|---|---|
| `src/minima_harness/agent/tools.py` | `AgentTool`, `ToolResult`, `error_result` — the tool contract |
| `src/minima_harness/tools/bash.py` | **Your template** — copy its shape |
| `src/minima_harness/tools/builtin.py` | `default_toolset()` — where tools are registered |
| `src/minima_harness/ai/types.py` | `TextContent`, `ContentBlock` — what tools return |
| `src/minima/catalog/sources/litellm.py` | The async `httpx` pattern to copy |
| `src/minima_harness/agent/loop.py` | The agent loop that executes your tools |
| `src/minima_harness/tui/cli.py` | `minima` entry point — run it end-to-end |
| `src/minima_harness/minima/runtime.py` | Phase 2: route → run → feedback |

## Files you'll create

- `scratch/exa_search.py` — Project 1 throwaway (don't commit, or put under a scratch dir)
- `src/minima_harness/tools/_exa.py` — shared Exa client (`exa_search`, `exa_contents`)
- `src/minima_harness/tools/web_search.py` — Project 2
- `src/minima_harness/tools/web_fetch.py` — Project 3
- `tests/.../test_web_search.py`, `test_web_fetch.py` — Project 5

## Guiding principles (re-read when stuck)

1. **End-to-end over perfect.** Make the ugliest version work, then improve it.
2. **One hard thing at a time.** That's why Project 1 has no harness and Project 5 has no network.
3. **The `description` is a prompt.** If the model misuses a tool, fix the words first.
4. **Fail with a message, not a traceback.** Every tool error becomes text the model reads.
5. **Don't commit secrets.** `EXA_API_KEY` lives in the environment, always.
