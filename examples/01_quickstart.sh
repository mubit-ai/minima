#!/usr/bin/env bash
# Example 1 — Quickstart with raw curl.
#
# Exercises every Costit endpoint with nothing but curl + jq. Start the service first
# (`make run`). Override the URL with COSTIT_URL; in multi-tenant mode set COSTIT_KEY.
#
#   bash examples/01_quickstart.sh
set -euo pipefail

URL="${COSTIT_URL:-http://localhost:8080}"
AUTH=()
if [[ -n "${COSTIT_KEY:-}" ]]; then AUTH=(-H "authorization: Bearer ${COSTIT_KEY}"); fi
JQ() { if command -v jq >/dev/null; then jq "$@"; else cat; fi; }

echo "== health =="
curl -s "${AUTH[@]}" "$URL/v1/health" | JQ .

echo; echo "== catalog (3 cheapest) =="
curl -s "${AUTH[@]}" "$URL/v1/models?include_stale=true" | JQ '.models[:3]'

echo; echo "== recommend =="
REC=$(curl -s "${AUTH[@]}" "$URL/v1/recommend" -H 'content-type: application/json' -d '{
  "task": {"task": "Summarize this 2-page incident report into 3 bullet points.",
           "task_type": "summarization", "expected_input_tokens": 1800,
           "expected_output_tokens": 120},
  "cost_quality_tradeoff": 3
}')
echo "$REC" | JQ '{recommendation_id, model: .recommended_model.model_id,
                    est_cost_usd: .recommended_model.est_cost_usd,
                    basis: .decision_basis, breakdown: .recommended_model.est_cost_breakdown,
                    warnings}'

REC_ID=$(echo "$REC"   | JQ -r '.recommendation_id')
MODEL=$(echo "$REC"    | JQ -r '.recommended_model.model_id')

echo; echo "== feedback (you ran '$MODEL' yourself, then report how it went) =="
curl -s "${AUTH[@]}" "$URL/v1/feedback" -H 'content-type: application/json' -d "{
  \"recommendation_id\": \"$REC_ID\",
  \"chosen_model_id\": \"$MODEL\",
  \"outcome\": \"success\",
  \"quality_score\": 0.95,
  \"input_tokens\": 1760, \"output_tokens\": 110, \"actual_cost_usd\": 0.0021,
  \"verified_in_production\": true
}" | JQ .

echo; echo "== strategies (rules promoted for this namespace) =="
curl -s "${AUTH[@]}" "$URL/v1/strategies?max_strategies=5" | JQ '{count, strategies}'
