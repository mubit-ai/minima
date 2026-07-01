/**
 * minima-tui — TS harness + Ink TUI port of minima_harness.
 *
 * Phases 0–4 land here: the recommender-service client, the AI layer (types,
 * streaming, provider registry, faux + openai-compat providers), the agent core
 * (events/state/tools/loop/Agent), the coding tools (read/write/edit/bash/ls), and
 * the Minima integration layer (config/mapping/meter/judge/router/runtime). The Ink
 * TUI + cli entry (Phase 6) and the compiled binary (Phase 7) follow.
 */

export * from "./minima/index.ts";
export * from "./ai/index.ts";
export * from "./agent/index.ts";
export * from "./tools/index.ts";
