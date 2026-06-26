# Changelog

All notable changes to Minima are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.4.10] - 2026-06-26

### Changed
- **`minima-cli` is now published to PyPI automatically on every release** — `pip install minima-cli`
  is the official install (it bundles the `minima_client` SDK). A new CI job builds + uploads the
  sdist/wheel alongside the GitHub release and prod deploy.

### Fixed
- **Docs (API reference):** corrected the `GET /v1/health` response example (it returns `mubit`
  not `memory`, `version 0.4.9`, plus `auth`/`reasoner` blocks and `catalog.cost_source`) and
  clarified `status` is only `degraded` on a key-bearing probe; documented the real
  `summary.realized` field set (it differs from `summary.estimated`); and fixed the `days`
  parameter bound (`>0–365`) on `/v1/savings` and `/v1/calibration`. Added a PyPI install link to
  the Client SDK page.

## [0.4.9] - 2026-06-26

### Fixed
- **Multi-turn conversations with thinking enabled no longer 400 on Anthropic.** With extended
  thinking on, Anthropic signs each thinking block and requires the signature echoed back when the
  block is replayed — so the second turn of any thinking conversation (and any thinking + tool-use
  turn) failed with `messages.N.content.0.thinking.signature: Field required`. The provider now
  captures the `signature_delta` onto the thinking block and sends it back; an unsigned thinking
  block (from another provider or an older session) is dropped rather than sent unsigned.
- **Text selection works again in macOS Terminal.app.** Terminal.app doesn't report mouse-motion
  events (xterm mode 1003), which Textual needs for in-app drag-select — so capturing the mouse
  there gave neither in-app selection nor Terminal.app's native selection (only wheel-scroll). The
  mouse default is now resolved per-terminal: ON everywhere (scroll + in-app drag-select, as in
  iTerm2/Ghostty/WezTerm), but OFF on macOS Terminal.app so native click-drag selection + copy work
  out of the box (scroll with PageUp/PageDown). `--mouse`/`--no-mouse` overrides; `/mouse` toggles.

## [0.4.8] - 2026-06-26

### Fixed
- **A provider whose API key is invalid no longer wastes every turn routed to it.** When a model
  call hard-fails on auth (e.g. an invalid `ANTHROPIC_API_KEY` → `401 invalid x-api-key`), that
  provider is now blacklisted for the session and the *same* message is auto-rerouted onto a
  provider whose key works — instead of the router re-recommending the dead provider on every
  turn. The auth failure is also no longer fed back to Minima as a model-quality failure (it's a
  credential problem, not a quality signal), so it can't poison the model's success estimate in
  your namespace. Routing now also drops providers with no key configured up front, `/reconnect`
  (and a key fixed via `/config`) clears the blacklist, and pins are never auto-rerouted.
- **Scroll-wheel and text selection/copy both work now.** Terminal mouse-tracking is
  all-or-nothing — capturing the mouse for scroll-wheel suppresses the terminal's native
  click-drag selection. Mouse capture is back ON by default (wheel scroll + in-app drag-select),
  the terminal's native selection stays reachable by holding the bypass modifier while dragging
  (Option on macOS, Shift on Linux), and copy now also pushes to the OS clipboard
  (`pbcopy`/`xclip`/`wl-copy`) — Textual's built-in copy emits only OSC 52, which macOS
  Terminal.app silently ignores, so selections *looked* copied but weren't.

### Added
- **`/resume` picker shows timestamps** — each session row now shows when it was created and last
  used (e.g. `used 2h ago · created 3d ago`), and the list is sorted most-recently-used first.
- **`/mouse [on|off]`** command to toggle mouse capture live (scroll-wheel vs. terminal-native
  selection) without restarting, plus a **`--no-mouse`** launch flag and an OS-aware selection
  hint on the splash.

## [0.4.7] - 2026-06-26

### Fixed
- **Gemini calls failed whenever a tool with a nested-model schema was attached** — including
  the `/ledger` `tasks` tool (its `TaskItem` list). Pydantic emits `$ref`/`$defs` for nested
  models, and the google-genai SDK's strict `Schema` model rejects those with a
  `ValidationError` (`extra_forbidden` on `$ref`), failing the entire call. Because the error
  text contains `extra_forbidden`, it was *misclassified* as a `403` "Access denied (key lacks
  permission, or no quota)" — so it looked like a key/quota problem when it was a client-side
  schema issue. (This is why Gemini "stopped working" once a ledger goal was active; introduced
  with the `tasks` tool in 0.4.4.) The Google provider now sends tool schemas via
  `parameters_json_schema` (the SDK's standard-JSON-Schema path, which inlines/converts `$ref`
  itself per Gemini's function-declaration rules) instead of the strict `parameters` model.
- **Client-side validation errors are no longer misread as provider auth failures.**
  `classify_provider_error` now detects a pydantic/schema `ValidationError` first and reports it
  as a tool-schema problem ("pin another model / report it"), so a `extra_forbidden` can never
  again masquerade as a `403`/permission denial.

## [0.4.6] - 2026-06-26

### Added
- **Raw provider errors are now surfaced and logged.** Alongside the clean classified message,
  a failed model call now shows the provider's exact words (`└ provider said: …`) in the TUI and
  logs them at WARNING, so an ambiguous `403/429` ("key lacks permission, or no quota") is
  self-diagnosing — you can see whether it's `RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, a project
  issue, or model availability, instead of guessing.

### Fixed
- **One provider hiccup wedged the entire session.** A failed model call (bad key, 403/429,
  network) is swallowed into an *empty* assistant message with `stop_reason="error"`, which the
  agent loop appended to history. On the *next* turn — even to a healthy provider — that empty
  text block made the request invalid (Anthropic `400 "messages: text content blocks must be
  non-empty"`), so a single hiccup broke every subsequent turn until the session was cleared.
  Now (1) the loop never sends a failed call's assistant to a provider, and (2) a failed turn is
  rolled fully out of the agent's context (assistant + the user message that triggered it), so
  the next turn starts clean. Regression introduced in 0.4.4 (when provider errors began being
  swallowed into an empty assistant rather than raised). Verified against the live Anthropic API.
- **A failed model call was framed as "routing offline … /reconnect to retry Minima."** When
  routing *succeeds* but the model *call* fails, the banner now reads e.g. `⚠ Access denied by
  Google Gemini … — check GEMINI_API_KEY (/config) or pin another model (/model)` instead of the
  misleading routing/reconnect framing. The provider-403 message also gained an actionable next
  step (it was the only `classify_provider_error` branch without one).
- **Switching models left a stale error banner up.** After a model's call failed, pinning or
  unpinning a different model (`/model …`, `/model auto`) now clears the banner — a prior
  model's "access denied"/offline message no longer lingers as if it were still happening.
- **Pinning a model not in Minima's routing catalog 422'd and ran the wrong model.** Pinning
  e.g. an OpenRouter-namespaced model (`google/gemini-2.5-flash`) sent it to Minima as a routing
  constraint; Minima didn't recognize the id → `422 no models match the supplied constraints` →
  routing degraded offline and ran a *different* fallback model, while the footer/banner
  disagreed with what actually ran. A pin is now a true override: it bypasses Minima entirely
  and runs exactly the pinned model (basis `pinned`), so any registered model — OpenRouter,
  local, custom — can be pinned and runs as-is.

## [0.4.5] - 2026-06-26

### Fixed
- **Routing 401'd for the whole session when the Mubit key wasn't resolvable at launch.**
  The `AsyncMinimaClient`'s `Authorization` header is fixed when the client is built, so a
  Mubit key added via the `/config` overlay (or exported after launch) never took effect —
  `/reconnect` only cleared the banner without rebuilding the client, leaving every turn
  routing offline with `minima error 401: pass your Mubit API key …` until a full restart.
  Now `/reconnect` (and saving a routing key/URL in `/config`) re-reads the environment and
  rebuilds the Minima client in place, so the fix applies immediately — no restart.
- **Offline-fallback banner for an auth/config problem misleadingly said "/reconnect to
  retry."** A no-key or rejected-key 401/403 is now classified separately from a transient
  outage: the banner shows the actionable step ("no Mubit API key — add MUBIT_API_KEY via
  /config") and drops the "/reconnect" framing (retrying alone wouldn't help). Transient
  causes (timeout/unreachable) keep the "/reconnect to retry" banner.
- **No-key + hosted Minima made a guaranteed-401 round-trip every turn.** With no key
  configured against a remote endpoint, routing now short-circuits instantly instead of
  waiting on a doomed request (local/loopback endpoints still attempt, so keyless local
  servers are unaffected).

## [0.4.4] - 2026-06-25

### Added
- **OpenRouter is now a full provider, not 4 hardcoded models.** Setting `OPENROUTER_API_KEY`
  fetches OpenRouter's entire live model list (`GET /api/v1/models`, ~340 models) with live
  pricing / context / modalities / reasoning, so any OpenRouter model is callable, pinnable, and
  routable. Cached to `~/.minima-harness/cache` with a 24h TTL; degrades live → stale cache →
  curated so startup never blocks or breaks offline.
- **`/ledger` — cost-aware goals.** Set a budgeted objective (`/ledger set <title>`,
  `/ledger budget <usd>`); the agent maintains a task checklist (the `tasks` tool, footer `N/M`,
  re-anchored into the prompt each turn and persisted across `--continue`/`--resume`). The goal
  conditions routing (its turns cluster in Minima's memory) and each turn's realized cost is
  attributed to it — `└ ledger · spent $X · ~$Y projected · budget $B` — the cost-to-goal view no
  other agent has. (`/goals` remains as a hidden alias.)
- **Permission prompts before sensitive ops (default on).** write / edit / bash now ask first
  (Enter approve · `a` always-allow this tool · Esc reject), previewing a diff or the command.
  `/yolo` or `--dangerously-skip-permissions` disables prompting; `/edits` forces a diff review.
- **`/thoughts`** streams the model's reasoning into a muted bubble above each answer; **`/exit`**
  (and `/quit`) quit the TUI.

### Fixed
- **Provider failures are no longer silent.** A failed model call (bad/missing key, 401/403/404/
  429/402, network) was swallowed into an *empty* assistant message — a blank bubble in the TUI,
  an empty line on `--print`. The harness now classifies it and surfaces an actionable,
  provider-aware message (e.g. "Authentication failed for Anthropic running claude-opus-4-8 — set
  ANTHROPIC_API_KEY (/config)") in the TUI, on `--print` stderr (exit 1), and in `--mode json`.
  Tool failures (incl. permission denials) render prominently instead of a faint line.
- **OpenAI GPT-5 / o-series models 400'd on every call.** They reject `max_tokens` and require
  `max_completion_tokens`; the OpenAI-compatible provider now sends the right param for the
  `openai` provider (other OpenAI-compatible hosts keep `max_tokens`). Encoded as a small
  per-provider request-quirks table rather than a hardcoded branch.
- **`/confirm` could silently ignore your pick** (kept the routed model when a pick didn't
  resolve) — now warns; the decision card marks candidates with no provider key as `⚠ no key`.
- **`/model` had no way to unpin** — added an "auto (unpin)" entry + `/model auto` that restore
  the full routing pool.
- **Scary red banners for benign routing diagnostics** (`neighbor_classified`, `recall_timeout`,
  `cold_start`, …) — these are now suppressed; the banner is reserved for actionable issues.
- **Tool calls dumped raw JSON args** — now rendered IDE-style (diffs for edit/write, `$ cmd` for
  bash, a clean summary otherwise) with colorized diffs.
- **Errored turns were sometimes reported to Minima as successes** (when judging was off),
  poisoning the routing loop — now recorded as failures.
- **The launch splash was pinned to the left** instead of centered.
- **`/v1/models` price overlay** — the harness now overlays Minima's authoritative live pricing
  onto the registry at startup, so reported cost matches what the server routed against.

### Performance
- **`brew install minima` drops from ~5 min to ~3 s.** The Homebrew formula now installs
  dependencies from prebuilt wheels instead of compiling grpcio / cryptography / pydantic-core /
  jiter / cffi from source. (Apple Silicon + Linux compile nothing; macOS-Intel still builds only
  `cryptography`, which publishes no x86_64 wheel.)

## [0.4.3] - 2026-06-24

### Fixed
- **High CPU / fans during use.** The status bar repainted on *every* streamed token —
  `_append_stream` called `set_state("working")` per delta and `StatusBar.set_state`
  re-rendered unconditionally, so a 600-token reply triggered ~616 footer repaints (the
  terminal emulator repaints on each, which spins fans). `set_state` is now idempotent
  (no-op when the state is unchanged), the live-stream flush eased from ~33 Hz to ~16 Hz,
  and the spinner timer is **paused while idle** (no 10 Hz wake-ups when nothing is running).
  Measured: a 600-token stream drops from ~666 to ~40 repaints (~94% fewer); idle is quiet.
  Memory is unaffected (steady ~70 MB RSS, no leak).

## [0.4.2] - 2026-06-24

### Added
- **Multi-provider support (open & closed source).** A new provider catalog
  (`ai/provider_catalog.py`) integrates 21 LLM providers — closed-native (OpenAI, Anthropic,
  Gemini, DeepSeek, Mistral, xAI, Cohere, Perplexity), the OpenRouter aggregator, open-weight
  hosts (Groq, Together, Fireworks, DeepInfra, Cerebras, Hyperbolic, Novita), and local
  runtimes (Ollama, vLLM, LM Studio, llama.cpp, LocalAI). All speak the OpenAI
  chat-completions protocol, so a verified `base_url` + the right API-key env var is enough.
  Model ids + pricing were verified against each provider's official docs (June 2026).
- **Key-gated, provider-specific routing.** Each model resolves *its own* provider's key
  (a Groq model uses `GROQ_API_KEY`, never an OpenRouter key on `api.openai.com`); a provider's
  models are registered only when its key is configured (so the `/model` picker stays relevant);
  routing candidates and the offline fallback are filtered to models the user can actually run.
  The `/model` picker now lists every registered model so any provider's model can be pinned.
- **`minima config`** now lists the popular providers (Anthropic, OpenAI, Gemini, xAI, DeepSeek,
  Mistral, OpenRouter, Groq, Together); more providers work by exporting their env var, and
  local runtimes need no key.
- **Config overlay UX:** Enter walks the fields and lands on a visible **Save** button (Enter
  saves — Ctrl+S still works); the save hint is pinned in an always-visible footer.

### Fixed
- **`.env.example` shipped `MUBIT_ENDPOINT=http://127.0.0.1:3000`** and the docs said
  `cp .env.example .env`; the CLI auto-loads `./.env`, silently degrading Mubit memory to a
  dead localhost. The localhost default is now commented out, and `init_mubit` treats an empty
  endpoint as unset (hosted default applies).
- **OpenRouter-only / single-provider setups mis-routed.** The earlier key-aware fallback could
  pick `gpt-4o-mini` (which hits `api.openai.com`) for an OpenRouter key → guaranteed 401. Key
  eligibility is now provider-specific and base_url-aware; an unpriced (cost-0) custom/local
  model is no longer mistaken for the cheapest offline fallback.
- **`--offline` no longer dumps an httpx traceback** — routing fails fast with a clear
  "routing disabled (offline mode)" reason, and the expected offline-fallback log drops the
  stack trace (kept at DEBUG).

## [0.4.1] - 2026-06-24

### Fixed
- **Published CLI defaulted routing to `localhost:8080`.** A freshly installed `minima` (no
  project `.env.harness`) connected to a dev URL that isn't running, so every turn fell back to
  OFFLINE with "Minima unreachable" — while `minima config doctor` misleadingly reported the
  hosted endpoint. `DEFAULT_MINIMA_URL` is now `https://api.minima.sh` and is the single source
  of truth shared by the runtime, the config store, and `config doctor` (they can no longer
  drift). Local dev against `make run` sets `MINIMA_URL=http://localhost:8080` explicitly.
- **Offline fallback could pick an unrunnable model.** The degraded-mode fallback chose the
  globally cheapest model (gpt-4o-mini) regardless of configured keys, so an
  Anthropic+Gemini-only setup hit a provider-auth error offline. It now prefers the cheapest
  model whose provider key is actually set (e.g. `claude-haiku-4-5` / `gemini-2.5-flash`),
  falling back to the global cheapest only when no key is present.

## [0.4.0] - 2026-06-24

First public, source-available release. Headline theme: the **harness** becomes a
trustworthy, transparent cost-aware coding agent, and the **recommender** gains a
data-grounded cost range.

### Added
- **`minima-harness config`** — per-user credential management across three surfaces
  (CLI subcommand, `/config` TUI overlay, in-TUI editing). Secrets go to the **OS keyring**
  when available, falling back to `~/.minima-harness/config.env` at mode `0600`; loaded into
  the environment at lowest precedence. Sections: LLM provider keys + Mubit/Minima routing.
- **`/prompt` layered inspector** — every system-prompt layer (base, project context, session
  override, Mubit lessons) shown separately with per-layer token counts, editable in place.
- **`/optimize`** — Mubit-backed system-prompt optimization (consolidates lessons + outcomes,
  estimates token savings) with a local dedup fallback; never auto-applies.
- **Routing decision card** — each candidate framed as **cost (with predicted range) / speed /
  predictability**, an ROI line for pricier alternatives, and hybrid reasoning (data-grounded
  by default, the reasoner's natural language only when evidence is thin).
- **Data-grounded cost band** (server) — the recommend response now carries a p25–p75 cost band
  (`est_cost_low` / `est_cost_high` / `cost_band_basis`) and `success_interval_width`, computed
  from realized-cost history; honest "no range yet" when evidence is thin.
- **Cost predictability in `/stats`** — estimate-vs-actual MAPE and within-band hit-rate
  (estimated cost is now persisted per turn to the session log).
- **MINIMA CLI welcome banner** and a centered launch splash.
- `docs/publishing.md` — release checklist.

### Changed
- **License is now `FSL-1.1-Apache-2.0`** (Functional Source License — source-available,
  non-compete; each version converts to Apache-2.0 two years after publication). Previously
  `Proprietary`.
- **Mouse capture is OFF by default** so terminal text selection + copy (drag, then Cmd/Ctrl+C)
  works out of the box; `--mouse` opts into scroll-wheel support (otherwise PageUp/PageDown).
- Footer renders Ctrl shortcuts as `ctrl+l` etc. instead of the `^l` caret.
- Overlays (config, prompt, routing, optimize, and the model/session/command/tree pickers) share
  a consistent rounded-accent card style with border titles.

### Fixed
- Copy/paste broke when mouse capture was enabled by default — restored selection-friendly default.
- Harness Minima client timeout raised (10s → 30s) so a cold-start `recommend` that consults the
  reasoner no longer silently degrades to offline routing.

[0.4.0]: https://github.com/mubit-ai/minima/releases/tag/v0.4.0
