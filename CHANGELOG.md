# Changelog

All notable changes to Minima are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

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
