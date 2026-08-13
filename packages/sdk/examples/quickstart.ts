/**
 * The whole Minima loop with the TypeScript SDK — the TS twin of
 * `examples/02_recommend_and_feedback.py`.
 *
 *     recommend  ->  run the model yourself  ->  judge quality  ->  feedback
 *
 * Minima never runs, proxies, or caches an LLM call. It answers "which model should I
 * run for this task?" and gets sharper from the outcome you report back.
 *
 * Run it straight from a checkout — no publish, no `bun add`:
 *
 *     bun run packages/sdk/examples/quickstart.ts
 *
 * Set MINIMA_URL (default http://localhost:8080) and, against a shared deployment,
 * MUBIT_API_KEY (auth is pass-through — your Mubit key IS the credential).
 */

import { MinimaClient, MinimaError, MinimaUnavailable } from "../src/index.ts";

const URL = process.env.MINIMA_URL ?? "http://localhost:8080";
const KEY = process.env.MUBIT_API_KEY;

/** Stand-in for your inference call. Return what the provider ACTUALLY billed. */
function runTheModel(modelId: string, prompt: string) {
  return {
    text: `[simulated output from ${modelId}]`,
    inputTokens: Math.max(1, Math.floor(prompt.length / 4)),
    outputTokens: 180,
    costUsd: 0.00042,
    latencyMs: 900,
  };
}

/** Your real quality signal goes here (tests pass, eval rubric, human rating, ...). */
function grade(text: string): number {
  return text.length > 0 ? 0.9 : 0.0;
}

const minima = new MinimaClient({
  baseUrl: URL,
  ...(KEY ? { apiKey: KEY } : {}),
  timeoutMs: 10_000,
});

const prompt = "Extract the order id and total from: 'Order #A-9931 totalling $48.20 shipped.'";

try {
  // 1. recommend — the pool is yours to constrain; the pick is Minima's.
  const rec = await minima.recommend(
    { task: prompt, task_type: "extraction" },
    {
      costQualityTradeoff: 2.0, // 0 = cheapest that clears the bar, 10 = best quality
      constraints: { allowed_providers: ["anthropic"] },
      phase: "interactive",
    },
  );

  const model = rec.recommended_model;
  console.log(`routed to ${model.model_id} (${model.provider})`);
  console.log(`  basis      ${rec.decision_basis} (confidence ${rec.confidence.toFixed(2)})`);
  const basis = model.cost_band_basis || "estimate";
  console.log(`  est cost   $${model.est_cost_usd.toFixed(5)} (${basis})`);
  console.log(`  predicted  ${(model.predicted_success * 100).toFixed(1)}% success`);

  // 2. run it yourself, on your own stack, measuring real usage.
  const run = runTheModel(model.model_id, prompt);

  // 3. judge it.
  const quality = grade(run.text);
  const outcome = quality >= 0.8 ? "success" : quality >= 0.4 ? "partial" : "failure";

  // 4. feed the REALIZED numbers back. Reporting real tokens and real dollars is what
  // lets the cost basis climb estimate -> observed -> rescaled — the single biggest
  // accuracy lever in the loop. Never echo `est_cost_usd` back as the actual cost.
  //
  // evidenceSource "none" = cost/latency telemetry only, which is the honest label for a
  // simulated run. Claim "judge"/"human"/"gate" only when a real one produced the score.
  const fb = await minima.feedback(rec.recommendation_id, model.model_id, outcome, {
    usage: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: run.costUsd,
      latencyMs: run.latencyMs,
    },
    qualityScore: quality,
    evidenceSource: "none",
  });

  console.log(`fed back ${outcome} (quality ${quality.toFixed(2)}) — accepted=${fb.accepted}`);
} catch (err) {
  if (err instanceof MinimaUnavailable) {
    console.error(`Minima at ${URL} is unavailable (${err.status}). Retry shortly.`);
  } else if (err instanceof MinimaError) {
    console.error(`Minima rejected the request: ${err.message}`);
  } else {
    console.error(`could not reach Minima at ${URL}: ${err}`);
    console.error("start it with `make run`, or set MINIMA_URL to a live deployment.");
  }
  process.exitCode = 1;
}
