#!/usr/bin/env bash
set -euo pipefail

# Load .env
set -a; source "$(dirname "$0")/.env" 2>/dev/null || true; set +a

MINIMA_URL="${MINIMA_URL:-https://api.minima.sh}"
BIN="$(dirname "$0")/packages/tui/dist/minima"

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  Minima Routing E2E Test Suite                                   ║"
echo "║  Endpoint: $MINIMA_URL"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

run_test() {
  local label="$1"
  local prompt="$2"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "TEST: $label"
  echo "PROMPT: $prompt"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  # Run with JSON mode to capture events, extract routing info
  local output
  output=$(MINIMA_URL="$MINIMA_URL" "$BIN" --mode json "$prompt" 2>&1 || true)
  
  # Count turns and tool calls
  local turns=$(echo "$output" | grep -c '"turn_start"' || true)
  local tools=$(echo "$output" | grep -c '"tool_start"' || true)
  local errors=$(echo "$output" | grep -c '"error"' || true)
  local text_deltas=$(echo "$output" | grep '"text_delta"' | sed 's/.*"delta":"\(.*\)".*/\1/' | tr -d '\n' || true)
  
  echo "  Turns: $turns | Tool calls: $tools | Errors: $errors"
  if [ ${#text_deltas} -gt 0 ] && [ ${#text_deltas} -lt 500 ]; then
    echo "  Response: $text_deltas"
  elif [ ${#text_deltas} -ge 500 ]; then
    echo "  Response: $(echo "$text_deltas" | head -c 200)..."
  else
    echo "  Response: (empty or error)"
  fi
  echo ""
}

# ── Tier 1: Simple (should route to cheap models) ──────────────────
run_test "1. Simple Q&A" "What is 2+2?"
run_test "2. Basic text" "Write a one-line greeting."
run_test "3. Formatting" "Convert to uppercase: hello world"

# ── Tier 2: Code tasks (should route to mid-tier) ──────────────────
run_test "4. Code explanation" "Read the file packages/tui/src/tui/context.ts and explain what BASE_SYSTEM is in one sentence."
run_test "5. Directory listing" "Use ls to list files in the current directory and tell me how many there are."
run_test "6. Grep search" "Use grep to search for 'interface' in packages/tui/src/ai/types.ts"

# ── Tier 3: Complex reasoning (should route to stronger models) ────
run_test "7. Multi-file analysis" "Read AGENTS.md and give me a 3-bullet summary of the project."
run_test "8. Code understanding" "Read the file packages/tui/src/minima/runtime.ts and tell me what the promptRouted method does in 2 sentences."

# ── Tier 4: Edge cases ─────────────────────────────────────────────
run_test "9. Empty-ish" "hi"
run_test "10. Long output" "List the numbers 1 to 20."

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  Done. Check the routing decisions above — Minima should pick    ║"
echo "║  cheaper models for simple tasks and stronger ones for code.     ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
