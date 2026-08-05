/**
 * Per-provider and per-model request quirks, as DATA not control flow.
 *
 * Port of the Python harness's ai/provider_quirks.py. Most OpenAI-compatible hosts speak the
 * identical wire protocol; a few diverge on small details (e.g. OpenAI GPT-5/o-series
 * reject `max_tokens` and require `max_completion_tokens`). Encoded as a lookup table so
 * the next quirk is a one-line data entry, not a new branch in the provider.
 */

export interface ProviderQuirks {
  /** Name of the max-output-tokens param. */
  readonly tokenParam: string;
  /**
   * Payload fragment that explicitly pins reasoning OFF on this host, or null when the host
   * has no way to say it (sending nothing then beats sending a payload it would refuse).
   */
  readonly reasoningOff: Readonly<Record<string, unknown>> | null;
  /** Where an explicit effort value goes in the payload, as a key path. */
  readonly effortPath: readonly string[];
  /**
   * Effort vocabulary this HOST accepts. Deliberately conservative on the openai-compat
   * baseline: a value the host rejects is an HTTP 400 on the user's turn, while a clamped
   * one still reasons. `Model.effort_levels` widens it per model where that is verified.
   */
  readonly effortLevels: readonly string[];
}

const DEFAULT_QUIRKS: ProviderQuirks = {
  tokenParam: "max_tokens",
  reasoningOff: { reasoning_effort: "none" },
  effortPath: ["reasoning_effort"],
  effortLevels: ["low", "medium", "high"],
};

// Keyed by harness provider id. Only providers that DIVERGE from the baseline appear here.
//
// VERIFICATION STATUS (MUB-229, probed 2026-08-05 — this machine holds ANTHROPIC, GEMINI and
// OPENAI keys only, so nothing below may be extrapolated to a host that was not probed):
//   openai      VERIFIED  gpt-5.6-{sol,terra,luna}: reasoning_effort accepts none|low|medium|
//                         high|xhigh and 400s on minimal|max; gpt-4o and gpt-4o-mini answer
//                         "Unrecognized request argument supplied: reasoning_effort" at EVERY
//                         value, "none" included. xhigh is accepted on the gpt-5.6 family, but
//                         the baseline stays {low,medium,high} until a model declares
//                         effort_levels — the row here is the host floor, not its ceiling.
//   anthropic   VERIFIED  claude-{opus-4-8,sonnet-5,fable-5}: output_config.effort accepts
//                         low|medium|high|xhigh|max and 400s on minimal and none — hence the
//                         wider vocabulary AND reasoningOff:null (the host cannot say "off").
//   google      VERIFIED  by code, not wire: the google provider sends thinkingConfig only
//                         (providers/google.ts), never an effort — so the honest vocabulary
//                         is empty and the status bar reports the model's own default.
//   openrouter  UNVERIFIED  no OPENROUTER_API_KEY on this machine. Shapes below are taken
//                         from the host's own /api/v1/models declaration: 213 of 338 models
//                         advertise the `reasoning` parameter against 90 for `reasoning_effort`,
//                         so the nested object is the better-supported spelling. The off-shape
//                         is the one agreed in MUB-227.
//   xai, groq, deepseek, together  UNVERIFIED  no keys. They inherit the openai-compat
//                         baseline, which is this ticket's accepted risk: a host that rejects
//                         `reasoning_effort` outright would 400 a thinking-level turn that
//                         used to send nothing. `Model.effort_levels: []` opts a model out
//                         without a code change once someone with a key finds out.
const QUIRKS: Record<string, Partial<ProviderQuirks>> = {
  openai: { tokenParam: "max_completion_tokens" },
  openrouter: {
    reasoningOff: { reasoning: { enabled: false } },
    effortPath: ["reasoning", "effort"],
  },
  anthropic: {
    reasoningOff: null,
    effortPath: ["output_config", "effort"],
    effortLevels: ["low", "medium", "high", "xhigh"],
  },
  google: { effortLevels: [] },
};

/** Quirks for `provider` (the baseline OpenAI-compatible behavior if it has none). */
export function quirksFor(provider: string): ProviderQuirks {
  const override = QUIRKS[provider];
  return override ? { ...DEFAULT_QUIRKS, ...override } : DEFAULT_QUIRKS;
}

/**
 * Anthropic thinking API shape a model needs (MUB-182):
 *   - "enabled":  classic `thinking: {type: "enabled", budget_tokens}` (pre-4.7 models;
 *     still functional on Opus 4.6 / Sonnet 4.6).
 *   - "adaptive": `thinking: {type: "adaptive"}` + `output_config: {effort}` — models that
 *     400 on "enabled" ("thinking.type.enabled is not supported for this model").
 *   - "none":     no reasoning capability; never send thinking kwargs.
 */
export type ThinkingFormat = "enabled" | "adaptive" | "none";

/**
 * Thinking API shape for `model` ("none" when the model cannot reason at all).
 *
 * Which models require the adaptive shape is DATA on the model registry — the
 * `Model.adaptive_thinking` flag (set in the seed catalog / at registration) is the single
 * source of truth; there is no id-pattern list here. Unflagged reasoning models keep the
 * classic shape so unknown/older models never regress.
 */
export function thinkingFormatFor(model: {
  reasoning?: boolean;
  adaptive_thinking?: boolean;
}): ThinkingFormat {
  if (!model.reasoning) return "none";
  return model.adaptive_thinking ? "adaptive" : "enabled";
}

/**
 * Whether `model` accepts image input. Same doctrine as thinkingFormatFor: the capability
 * is DATA on the registry (`Model.input`), not an id-pattern list here.
 *
 * FAIL-CLOSED — an absent `input` means UNKNOWN, and unknown must mean no. A text-only
 * model 400s on an image block, and models synthesized from the service catalog or
 * OpenRouter carry no modality until someone teaches them one. So a missing declaration
 * costs a refused image, never a broken run.
 */
export function supportsImageInput(model: { input?: readonly string[] } | null): boolean {
  return model?.input?.includes("image") === true;
}

/**
 * Whether this request must pin `reasoning_effort: "none"`. Same doctrine as the two above:
 * the capability is DATA on the registry (`Model.tools_require_effort_none`), not an
 * id-pattern list here — and never a per-provider rule, since gpt-4o on the same provider
 * 400s on the parameter itself.
 *
 * `hasTools` is load-bearing. The API refuses only the TOOLS + effort combination, so a
 * tool-less call (judge, classifier, --no-tools) keeps the model's own default effort and
 * still reasons; pinning it unconditionally would silently downgrade those too.
 *
 * Rung 2 of the ladder, and deliberately not exported: effectiveEffort is the only entry
 * point, or the wire and the status bar can disagree again.
 */
function effortNoneWithTools(
  model: { tools_require_effort_none?: boolean },
  hasTools: boolean,
): boolean {
  return hasTools && model.tools_require_effort_none === true;
}

/**
 * What the status bar is describing — and, in `send`, exactly what goes on the wire.
 *
 *   honoured     the requested level is being sent as asked
 *   clamped      a level was requested; a narrower one is being sent
 *   pinned-none  effort is pinned off by the tools quirk, whatever was requested
 *   off          reasoning is definitively not happening (pinned off, or the model
 *                declares it cannot reason at all)
 *   default      nothing is sent, so the model applies its own server-side default —
 *                which is NOT the same as off, and must not be displayed as off
 */
export type EffortState = "honoured" | "clamped" | "pinned-none" | "off" | "default";

export interface EffortDecision {
  /** Wire effort value; undefined means send no effort parameter at all. */
  readonly send: string | undefined;
  readonly state: EffortState;
}

/** Harness thinking levels, weakest first. Anything outside this map is not a level. */
const LEVEL_RANK: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4 };

/** A model as far as the effort ladder is concerned. */
export interface EffortModel {
  provider: string;
  reasoning?: boolean;
  effort_levels?: readonly string[];
  tools_require_effort_none?: boolean;
  requires_explicit_effort_off?: boolean;
}

/**
 * The single answer to "what effort does this request carry?" (MUB-229).
 *
 * Both consumers read this one function — the provider builds its payload from `.send`, the
 * status bar renders `.state` — so the indicator cannot drift from the wire. Before it, the
 * bar rendered a thinking level that five openai-compat hosts never received.
 *
 * The ladder, highest precedence first:
 *   1. `requires_explicit_effort_off` — this model needs to be told "off" out loud.
 *   2. `tools_require_effort_none` + tools present — the gpt-5.6 refusal (#328). Verified
 *      live: ANY non-none effort alongside function tools 400s, so this must outrank a
 *      requested level rather than losing to it.
 *   3. a thinking level is set — sent, clamped into the accepted vocabulary if need be.
 *   4. otherwise nothing, and the model applies its own default.
 *
 * Rung 3 is FAIL-CLOSED on `Model.reasoning`: an undeclared model never receives the
 * parameter, because gpt-4o rejects it at every value (verified) and models synthesized
 * from a catalog carry no capability until someone teaches them one. The cost of an absent
 * declaration is a missed effort param, never a broken turn.
 */
export function effectiveEffort(
  model: EffortModel,
  hasTools: boolean,
  requested: unknown,
): EffortDecision {
  if (model.requires_explicit_effort_off === true) return { send: "none", state: "off" };
  if (effortNoneWithTools(model, hasTools)) return { send: "none", state: "pinned-none" };

  // Nothing on the wire. "off" only when the model itself says it cannot reason; an unknown
  // model gets "default", since we are declining to send — not claiming the model is silent.
  const nothing: EffortDecision = {
    send: undefined,
    state: model.reasoning === false ? "off" : "default",
  };

  const level = typeof requested === "string" ? requested : undefined;
  if (level === undefined || LEVEL_RANK[level] === undefined) return nothing; // incl. "off"
  if (model.reasoning !== true) return nothing;

  const allowed = (model.effort_levels ?? quirksFor(model.provider).effortLevels).filter(
    (l) => LEVEL_RANK[l] !== undefined,
  );
  if (!allowed.length) return nothing;
  if (allowed.includes(level)) return { send: level, state: "honoured" };
  return { send: clampInto(level, allowed), state: "clamped" };
}

/** The strongest accepted level at or below `level`; the weakest accepted one if none is. */
function clampInto(level: string, allowed: readonly string[]): string {
  const want = LEVEL_RANK[level]!;
  const ranked = [...allowed].sort((a, b) => LEVEL_RANK[a]! - LEVEL_RANK[b]!);
  let best = ranked[0]!;
  for (const l of ranked) {
    if (LEVEL_RANK[l]! <= want) best = l;
  }
  return best;
}

/**
 * The payload fragment carrying `send` on `provider`'s wire — the SHAPE half of the split
 * this ticket rests on: whether to send is per-model (registry), how to spell it is
 * per-provider (the table above).
 */
export function reasoningPayload(
  provider: string,
  send: string | undefined,
): Record<string, unknown> {
  if (send === undefined) return {};
  const quirks = quirksFor(provider);
  if (send === "none") return quirks.reasoningOff ? { ...quirks.reasoningOff } : {};
  const path = quirks.effortPath;
  if (!path.length) return {};
  let value: unknown = send;
  for (let i = path.length - 1; i > 0; i -= 1) value = { [path[i]!]: value };
  return { [path[0]!]: value };
}
