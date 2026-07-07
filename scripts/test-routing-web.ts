#!/usr/bin/env bun
/**
 * Live routing + web_fetch test suite.
 * Sends prompts that exercise both Minima routing decisions and the web_fetch tool.
 *
 * Usage: bun run scripts/test-routing-web.ts
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
  toolsUsed: string[];
  errors: number;
  durationMs: number;
}

const TESTS: { label: string; prompt: string; category: string }[] = [
  // ── Pure routing: simple vs complex ────────────────────────────
  {
    label: "Trivial (should route cheap)",
    prompt: "What is the capital of Japan?",
    category: "routing-simple",
  },
  {
    label: "Complex reasoning (should route strong)",
    prompt: "Explain the difference between a monad and a functor in 3 sentences with a code example in TypeScript.",
    category: "routing-complex",
  },

  // ── Web fetch: documentation lookup ────────────────────────────
  {
    label: "Fetch npm package docs",
    prompt: "Use web_fetch to read https://www.npmjs.com/package/zod and tell me what zod is in one sentence.",
    category: "web-docs",
  },
  {
    label: "Fetch GitHub README",
    prompt: "Use web_fetch to read https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/README.md and list 3 topics it covers.",
    category: "web-docs",
  },

  // ── Routing + web_fetch combined ───────────────────────────────
  {
    label: "API docs lookup",
    prompt: "Use web_fetch to read https://api.minima.sh/v1/models and tell me which model has the largest context window.",
    category: "web+routing",
  },
  {
    label: "Error message research",
    prompt: "Use web_fetch to read https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429 and explain what HTTP 429 means in one sentence.",
    category: "web+routing",
  },

  // ── Multi-tool chaining: web_fetch + filesystem ────────────────
  {
    label: "Compare online vs local",
    prompt: "Use web_fetch to read https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/README.md, then tell me how many dependencies it lists.",
    category: "multi-tool",
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
  const toolsUsed: string[] = [];
  let errors = 0;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "turn_start") turns++;
      if (ev.type === "tool_start") {
        toolCalls++;
        toolsUsed.push(ev.name ?? "?");
      }
      if (ev.type === "error") errors++;
      if (ev.type === "text_delta") response += ev.delta ?? "";
    } catch {
      // skip
    }
  }

  return {
    label: test.label,
    prompt: test.prompt,
    category: test.category,
    response: response.slice(0, 300),
    turns,
    toolCalls,
    toolsUsed,
    errors,
    durationMs,
  };
}

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  Routing + Web Fetch — Live E2E Test                                ║");
console.log(`║  Endpoint: ${MINIMA_URL.padEnd(54)}║`);
console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

const results: TestResult[] = [];

for (const test of TESTS) {
  process.stdout.write(`▶ ${test.label}... `);
  try {
    const result = await runOne(test);
    results.push(result);
    const status = result.errors > 0 ? "❌" : "✅";
    const tools = result.toolsUsed.length ? `[${result.toolsUsed.join(",")}]` : "no-tools";
    console.log(
      `${status} ${result.turns}T ${tools} ${(result.durationMs / 1000).toFixed(1)}s`,
    );
  } catch (exc) {
    console.log(`💥 ${String(exc).slice(0, 80)}`);
    results.push({
      ...test,
      response: `CRASH: ${String(exc)}`,
      turns: 0,
      toolCalls: 0,
      toolsUsed: [],
      errors: 1,
      durationMs: 0,
    });
  }
}

console.log("\n┌─ Detailed Results ───────────────────────────────────────────────────┐");

for (const r of results) {
  const status = r.errors > 0 ? "❌" : "✅";
  console.log(`\n${status} [${r.category}] ${r.label}`);
  console.log(`   Q: ${r.prompt.slice(0, 100)}`);
  console.log(`   A: ${r.response.slice(0, 250) || "(no text)"}`);
  console.log(`   ${r.turns} turns · tools: ${r.toolsUsed.join(", ") || "none"} · ${(r.durationMs / 1000).toFixed(1)}s`);
}

const passed = results.filter((r) => r.errors === 0).length;
const webUsed = results.filter((r) => r.toolsUsed.includes("web_fetch")).length;
console.log(`\n╚══════════════════════════════════════════════════════════════════════╝`);
console.log(`${passed}/${results.length} passed · ${webUsed} used web_fetch`);
