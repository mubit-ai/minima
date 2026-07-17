/**
 * MP15 latency bench — a scripted 3-turn planning session against a DELAYED, content-aware
 * meta provider (every meta complete() costs META_MS; the researcher child costs
 * RESEARCH_MS), measuring per-turn wall-clock. Run the SAME script on the merge base and on
 * the MP15 branch: the base convenes a full council every substantive turn; MP15 convenes
 * only the stakes turn and runs the keeper mini-update on the follow-ups. Replies are keyed
 * on each role's SYSTEM prompt (order-independent), so the one script is valid on both
 * trees. Hermetic: faux provider + mock spawn, no network, no spend.
 *
 *   bun packages/tui/scripts/plan_latency_bench.ts
 *
 * Env: BENCH_META_MS (default 400) · BENCH_RESEARCH_MS (default 1500)
 */

import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { registerProvider } from "../src/ai/providers/base.ts";
import { PlanSessionStore } from "../src/minima/plan_session.ts";
import { runPlanTurn } from "../src/minima/plan_turn.ts";
import { runCouncilRound } from "../src/minima/plan_council.ts";
import type { ChildResult, Delegation, SpawnFn } from "../src/tools/task.ts";

const META_MS = Number(process.env.BENCH_META_MS ?? 400);
const RESEARCH_MS = Number(process.env.BENCH_RESEARCH_MS ?? 1500);

const META_MODEL: Model = {
  id: "bench-meta",
  provider: "faux",
  api: "faux",
  name: "Bench Meta",
  cost: { input: 1, output: 1 },
  context_window: 8192,
  max_tokens: 1024,
};

const reply = (s: string): AssistantMessage => new AssistantMessage({ content: [text(s)] });

function pickBySystem(system: string): AssistantMessage {
  if (system.includes("break the RESEARCH needed")) {
    return reply(
      JSON.stringify([
        {
          focus: "inspect the cache",
          boundaries: "read only",
          output_format: "notes",
          difficulty: "easy",
        },
      ]),
    );
  }
  if (system.includes("reviewing researcher findings")) return reply("[]");
  if (system.includes("adversarial CRITIC")) return reply("[]");
  if (system.includes("keeping the working draft current")) {
    return reply(
      JSON.stringify({ plan: "Draft refreshed by the keeper.", decisions: [], questions: [] }),
    );
  }
  if (system.includes("SYNTHESIST")) return reply("A concrete plan draft, step by step.");
  if (system.includes("RECORDER")) {
    return reply(
      JSON.stringify({
        plan: "A concrete plan draft, step by step.",
        decisions: [],
        questions: [],
      }),
    );
  }
  return reply("bench fallback reply");
}

async function main(): Promise<void> {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(META_MODEL);
  const reg = registerFauxProvider([META_MODEL]);
  const inner = { reg };

  type StreamFn = (
    model: Model,
    context: { system_prompt?: string | null },
    opts: unknown,
  ) => AsyncIterable<unknown>;
  registerProvider("faux", {
    async *stream(model: Model, context: { system_prompt?: string | null }, opts: unknown) {
      await Bun.sleep(META_MS);
      inner.reg.setResponses([pickBySystem(context.system_prompt ?? "")]);
      const provider = (inner.reg as unknown as { provider: { stream: StreamFn } }).provider;
      yield* provider.stream(model, context, opts);
    },
  } as never);

  const spawn: SpawnFn = async (d: Delegation): Promise<ChildResult> => {
    await Bun.sleep(RESEARCH_MS);
    return {
      step_id: d.step_id,
      childId: `${d.step_id}-child`,
      text: "bench finding",
      costUsd: 0.01,
      quality: null,
      outcome: "success",
      workdir: null,
    };
  };

  const store = new PlanSessionStore("");
  const turns = [
    "please design a storage layer for the session cache with tests",
    "how should the eviction policy interact with the tests you proposed?",
    "should we also handle the persistence edge case for restarts cleanly?",
  ];

  const times: number[] = [];
  for (const turn of turns) {
    const t0 = performance.now();
    await runPlanTurn(store, turn, {
      runRound: (session, t, o) =>
        runCouncilRound(session, t, {
          parent: {} as never,
          metaModel: META_MODEL,
          spawn,
          signal: o.signal,
          roundBudgetUsd: o.roundBudgetUsd,
        }),
      askUser: null,
      onNote: () => {},
      buildSystem: (s) => `BENCH PERSONA\n\n${s.snapshotBlock()}`,
      promptPlanner: async () => {
        await Bun.sleep(META_MS);
        return null;
      },
      controllerRef: { current: null },
      runMiniUpdate: async (session, t, o) => {
        const mod = await import("../src/minima/plan_council.ts");
        const fn = (mod as Record<string, unknown>).runKeeperMiniUpdate as
          | ((
              s: unknown,
              u: string,
              r: string,
              opts: unknown,
            ) => Promise<{ update: unknown; costUsd: number }>)
          | undefined;
        if (!fn) return { update: null, costUsd: 0 };
        return fn(session, t, "Planner reply for the bench.", {
          metaModel: META_MODEL,
          signal: o.signal,
        }) as never;
      },
    } as never);
    times.push((performance.now() - t0) / 1000);
  }

  const total = times.reduce((a, b) => a + b, 0);
  console.log(`meta=${META_MS}ms research=${RESEARCH_MS}ms`);
  times.forEach((t, i) => console.log(`turn ${i + 1}: ${t.toFixed(2)}s  (${turns[i]})`));
  console.log(
    `total: ${total.toFixed(2)}s · rounds=${store.session.rounds} · draft="${store.session.draft.slice(0, 40)}"`,
  );
  reg.unregister();
}

await main();
