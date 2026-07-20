# @mubit-ai/minima-sdk

TypeScript SDK for the [Minima](https://docs.minima.sh) recommender service — a typed
`/v1/*` client for the loop:

```
recommend  →  run the model yourself  →  judge quality  →  feedback
```

Minima never runs, proxies, or caches an LLM call. It answers "which model should I run
for this task?" and learns from the outcome you report back.

## Install

```sh
bun add @mubit-ai/minima-sdk   # or npm/pnpm/yarn — pure fetch, no runtime deps
```

## Quickstart

```ts
import { MinimaClient } from "@mubit-ai/minima-sdk";

const minima = new MinimaClient({
  baseUrl: "https://api.minima.sh",
  apiKey: process.env.MUBIT_API_KEY,
});

// 1. recommend
const rec = await minima.recommend("refactor the auth module", {
  constraints: { candidate_models: ["claude-haiku-4-5", "claude-sonnet-4-6"] },
  phase: "interactive",
});

// 2. run rec.recommended_model.model_id yourself, measuring what it ACTUALLY cost

// 3.+4. close the loop with realized usage — never echo est_cost_usd back
await minima.feedback(rec.recommendation_id, rec.recommended_model.model_id, "success", {
  usage: { inputTokens: 1800, outputTokens: 600, costUsd: 0.0042, latencyMs: 9000 },
  evidenceSource: "none", // telemetry; pass "judge"/"human"/"gate" only with a real label
});
```

Honesty rules baked in: unlabeled outcomes ride as `evidence_source: "none"` (cost
telemetry — they never touch the success posterior), feedback retries transparently on
transient faults (the server dedupes), and `recommend` fails fast so your caller can
fail open.

Reporting: `savings()`, `calibration()`, `policyValue()` (doubly-robust
regret-vs-oracle), `models()`, `strategies()`, `capabilities()`, `health()`.

The wire types in `src/schemas.ts` mirror the server's Pydantic schemas
(`src/minima/schemas/*.py` is the source of truth; `tests/unit/test_ts_mirror.py` in the
repo pins the mirror mechanically).
