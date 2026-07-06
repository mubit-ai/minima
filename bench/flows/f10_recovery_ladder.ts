/**
 * F10 — recovery ladder, provider-failure rung (fully deterministic via mock + broken key).
 *
 * Setup: the mock /v1/recommend serves claude-haiku-4-5 first, gemini-2.5-flash from
 * then on; the spawn env carries a syntactically-present-but-invalid ANTHROPIC_API_KEY
 * (so haiku passes the client's providerKeyPresent runnable filter but hard-fails at
 * the provider). Expected: attempt 1 fails → ladder does a FRESH recommend with the
 * failed model in excluded_models (never a client-side re-rank) → flash succeeds.
 *
 * Judge-below-τ rung is NOT covered here (needs MINIMA_LLM_JUDGE=1 and a graded run;
 * with the default null judge the ladder never fires on quality) — future flow.
 */

import { Checks } from "../assert/check.ts";
import { HarnessDb } from "../assert/db.ts";
import { MockMinimaServer } from "../driver/mock_server.ts";
import { PtyRig } from "../driver/rig.ts";
import { MINIMA_BIN, makeScratch, saveArtifact, waitFor } from "../driver/scratch.ts";

function decisions(dbPath: string) {
  try {
    const db = new HarnessDb(dbPath);
    const d = db.decisions();
    db.close();
    return d;
  } catch {
    return [];
  }
}

export async function f10(): Promise<Checks> {
  const c = new Checks("f10_recovery_ladder");
  const s = makeScratch("f10");
  const mock = new MockMinimaServer(24000 + Math.floor(Math.random() * 9000));
  mock.recommendQueue = ["claude-haiku-4-5", "gemini-2.5-flash"];
  mock.start();

  const rig = PtyRig.spawn({
    cmd: [MINIMA_BIN],
    cwd: s.repoDir,
    env: {
      ...s.env,
      MINIMA_URL: mock.url,
      // Present (passes the runnable-candidates filter) but invalid at the provider.
      ANTHROPIC_API_KEY: "sk-ant-bench-broken-on-purpose",
    },
    wallClockMs: 240_000,
  });

  try {
    await rig.expectText(/· ready/, { timeoutMs: 20_000 });

    // The turn: attempt 1 (haiku) must hard-fail, rung 2 (flash) must answer.
    await rig.submitUntil(
      "Say the word lantern in lowercase, reply with just that word.",
      () => decisions(s.dbPath).some((d) => d.chosen_model === "gemini-2.5-flash"),
      { timeoutMs: 120_000 },
    );

    const recs = mock.captured("/v1/recommend");
    c.check("ladder: at least two recommend calls (fresh recommend per rung)",
      recs.length >= 2, `n=${recs.length}`);
    const second = recs[1]?.body as { constraints?: { excluded_models?: string[] } } | null;
    c.check("ladder: rung-2 recommend excludes the failed model",
      !!second?.constraints?.excluded_models?.includes("claude-haiku-4-5"),
      JSON.stringify(second?.constraints ?? {}));

    const dec = decisions(s.dbPath);
    c.check("ladder: winning decision row on gemini-2.5-flash",
      dec.some((d) => d.chosen_model === "gemini-2.5-flash" && d.routed === "server"),
      JSON.stringify(dec.map((d) => ({ m: d.chosen_model, r: d.routed, o: d.outcome }))));
    c.soft("ladder: failed-rung row recorded for haiku",
      dec.some((d) => d.chosen_model === "claude-haiku-4-5" && d.outcome !== "success"),
      JSON.stringify(dec.map((d) => ({ m: d.chosen_model, o: d.outcome }))));

    // /cost should label the retried work "(rung 2)".
    const m = rig.mark();
    const sawRung = await rig
      .submitUntil("/cost", /\(rung 2\)/, { timeoutMs: 20_000 })
      .then(() => true)
      .catch(() => false);
    c.check("meter: '(rung 2)' row visible in /cost", sawRung, rig.text().slice(m, m + 600));

    await rig.submitUntil("/exit", () => rig.exitCode !== null, { timeoutMs: 20_000 });
    const code = await rig.expectExit(15_000);
    c.check("/exit: clean exit 0", code === 0, `exit=${code}`);
  } finally {
    saveArtifact(s, "transcript.txt", rig.text());
    rig.kill();
    mock.stop();
  }
  return c;
}
