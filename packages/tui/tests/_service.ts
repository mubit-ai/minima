/**
 * TYPED builders for the /v1/* response payloads the test mocks return.
 *
 * Twenty-one test files hand-roll a `mockService()`, and thirty-seven build a recommend
 * payload. Those are legitimately different — each captures different fields, rejects
 * differently, sequences differently — and folding them into one configurable mock would
 * trade real clarity for a pile of options. The problem is narrower than duplication:
 * every payload is an untyped object literal, so `json: async () => ({ ... })` type-checks
 * against nothing. Add a required field to RecommendResponse and all thirty-seven keep
 * compiling while the harness reads undefined from a shape the server no longer sends.
 *
 * These builders are typed as the real wire interfaces, so tsc fails the moment a mock
 * drifts from the contract. Each takes an overrides object, which keeps a test's
 * interesting field on the line that cares about it and the other twenty out of the way.
 *
 * Transport and control flow stay in each test's own mockService — only the CONTRACT
 * shape is shared, because that is the only part that must not drift.
 */

import type {
  FeedbackResponse,
  RankedModel,
  RecommendResponse,
} from "../src/minima/schemas.ts";

/** One ranked candidate. Defaults resolve to the faux test provider. */
export function rankedModel(overrides: Partial<RankedModel> = {}): RankedModel {
  return {
    model_id: "test-faux",
    provider: "faux",
    predicted_success: 0.9,
    est_cost_usd: 0.001,
    score: 0.9,
    rationale: "test",
    decision_basis: "prior",
    ...overrides,
  };
}

/**
 * A complete RecommendResponse. `recommended_model` accepts a partial, so the common case
 * is `recommendResponse({ recommended_model: { model_id: "big" } })`.
 */
export function recommendResponse(
  overrides: Partial<Omit<RecommendResponse, "recommended_model">> & {
    recommended_model?: Partial<RankedModel>;
  } = {},
): RecommendResponse {
  const { recommended_model, ...rest } = overrides;
  const chosen = rankedModel(recommended_model);
  return {
    recommendation_id: "rec-1",
    recommended_model: chosen,
    ranked: [chosen],
    confidence: 0.8,
    decision_basis: "prior",
    threshold_used: 0.7,
    classified_task_type: "code",
    classified_difficulty: "medium",
    catalog_version: "test",
    ...rest,
  };
}

/** A complete FeedbackResponse; accepted unless a test says otherwise. */
export function feedbackResponse(overrides: Partial<FeedbackResponse> = {}): FeedbackResponse {
  return { accepted: true, ...overrides };
}
