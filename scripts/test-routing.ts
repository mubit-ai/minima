#!/usr/bin/env bun
/**
 * Routing E2E test — sends diverse prompts through Minima and reports
 * which model was chosen, cost, turns, and tool usage.
 *
 * Usage: bun run scripts/test-routing.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env
for (const f of [".env.harness", ".env"]) {
  const p = resolve(f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const BIN = resolve("packages/tui/dist/minima");
const MINIMA_URL = process.env.MINIMA_URL || "https://api.minima.sh";

interface TestResult {
  label: string;
  prompt: string;
  category: string;
  response: string;
  turns: number;
  toolCalls: number;
  errors: number;
  durationMs: number;
}

const TESTS: { label: string; prompt: string; category: string }[] = [
  // Simple (should route to cheapest)
  { label: "Simple math", prompt: "What is 2+2?", category: "simple" },
  { label: "Greeting", prompt: "Say hello in one sentence.", category: "simple" },
  { label: "Uppercase", prompt: "Convert to uppercase: hello world", category: "simple" },

  // Code (should route to mid-tier)
  {
    label: "Read file",
    prompt: "read AGENTS.md and tell me the first 3 lines",
    category: "code",
  },
  {
    label: "List dir",
    prompt: "use ls to list the current directory and count the entries",
    category: "code",
  },
  {
    label: "Grep search",
    prompt: "use grep to search for 'def promptRouted' in src/ and tell me the file path",
    category: "code",
  },

  // Complex reasoning (should route to stronger models)
  {
    label: "Architecture summary",
    prompt: "read AGENTS.md and give me a 3-bullet summary of what this project does",
    category: "complex",
  },
  {
    label: "Code analysis",
    prompt: "read packages/tui/src/tui/context.ts and explain what buildSystemPrompt does in 2 sentences",
    category: "complex",
  },
];

async function runOne(test: { label: string; prompt: string; category: string }): Promise<TestResult> {
  const start = Date.now();
  const proc = Bun.spawn([BIN, "--mode", "json", test.prompt], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MINIMA_URL },
  });

  const output = await new Response(proc.stdout).text();
  const durationMs = Date.now() - start;

  const lines = output.trim().split("\n").filter(Boolean);
  let response = "";
  let turns = 0;
  let toolCalls = 0;
  let errors = 0;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "turn_start") turns++;
      if (ev.type === "tool_start") toolCalls++;
      if (ev.type === "error") errors++;
      if (ev.type === "text_delta") response += ev.delta ?? "";
    } catch {
      // skip non-JSON
    }
  }

  return {
    label: test.label,
    prompt: test.prompt,
    category: test.category,
    response: response.slice(0, 200),
    turns,
    toolCalls,
    errors,
    durationMs,
  };
}

console.log("╔═══════════════════════════════════════════════════════════════════╗");
console.log("║  Minima Routing E2E Test                                          ║");
console.log(`║  Endpoint: ${MINIMA_URL.padEnd(50)}║`);
console.log("╚═══════════════════════════════════════════════════════════════════╝\n");

const results: TestResult[] = [];

for (const test of TESTS) {
  process.stdout.write(`▶ ${test.label}... `);
  try {
    const result = await runOne(test);
    results.push(result);
    const status = result.errors > 0 ? "❌" : "✅";
    console.log(
      `${status} ${result.turns}T/${result.toolCalls}tools/${(result.durationMs / 1000).toFixed(1)}s`,
    );
  } catch (exc) {
    console.log(`💥 ${String(exc).slice(0, 60)}`);
    results.push({
      ...test,
      response: `CRASH: ${String(exc)}`,
      turns: 0,
      toolCalls: 0,
      errors: 1,
      durationMs: 0,
    });
  }
}

console.log("\n┌─ Results ──────────────────────────────────────────────────────────┐");

for (const r of results) {
  const cat = r.category.toUpperCase().padEnd(7);
  const status = r.errors > 0 ? "❌" : "✅";
  console.log(`\n${status} [${cat}] ${r.label}`);
  console.log(`   Q: ${r.prompt.slice(0, 80)}`);
  console.log(`   A: ${r.response.slice(0, 150) || "(no text)"}`);
  console.log(`   ${r.turns} turns · ${r.toolCalls} tools · ${(r.durationMs / 1000).toFixed(1)}s`);
}

const passed = results.filter((r) => r.errors === 0).length;
console.log(`\n╚═══════════════════════════════════════════════════════════════════╝`);
console.log(`${passed}/${results.length} passed`);
