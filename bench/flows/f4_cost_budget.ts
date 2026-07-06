/**
 * F4 — PTY session: budget ladder + /clear lock-in + context retention (live server).
 *
 * Ordering encodes the critique-verified rule: spend under WARN first, tighten the
 * limit below observed spend, THEN flip to enforce — the next prompt is refused at the
 * exhausted gate ("budget exhausted: ...") with no provider spend and no decision row.
 * Also covers /budget mode shadow (uncovered in all original designs) and locks in
 * /clear being display-only (agent context retained).
 *
 * All submissions go through rig.submitUntil: the TUI drops Enter while the post-turn
 * judge/feedback/memory tail is still running (busy guard), so every command retries
 * Enter until its unique effect is observed.
 */

import { Checks } from "../assert/check.ts";
import { HarnessDb } from "../assert/db.ts";
import { PtyRig } from "../driver/rig.ts";
import { MINIMA_BIN, makeScratch, saveArtifact, waitFor } from "../driver/scratch.ts";

function snapshot(dbPath: string): { decisions: number; spent: number; mode: string | null } {
  try {
    const db = new HarnessDb(dbPath);
    const out = {
      decisions: db.decisions().length,
      spent: Number(db.budget()?.spent_usd ?? 0),
      mode: (db.budget()?.mode as string) ?? null,
    };
    db.close();
    return out;
  } catch {
    return { decisions: 0, spent: 0, mode: null };
  }
}

export async function f4(): Promise<Checks> {
  const c = new Checks("f4_cost_budget");
  const s = makeScratch("f4");

  const rig = PtyRig.spawn({
    cmd: [MINIMA_BIN],
    cwd: s.repoDir,
    env: s.env, // real MINIMA_URL from the user's config — this is the live-lane flow
    wallClockMs: 420_000,
  });

  try {
    await rig.expectText(/· ready/, { timeoutMs: 20_000 });

    // T1 — plant a token for the /clear lock-in later.
    await rig.submitUntil(
      "Remember this token: ZEBRA42. Then reply with just the word acknowledged in lowercase.",
      () => snapshot(s.dbPath).decisions >= 1,
      { timeoutMs: 120_000 },
    );
    c.check("T1: routed turn persisted", true);

    // Budget: none yet → set under warn.
    await rig.submitUntil("/budget", /No budget set/, { timeoutMs: 30_000 });
    c.check("/budget: reports none set", true);

    await rig.submitUntil("/budget set 0.02", /Budget set: \$0\.02 \(warn mode\)/, {
      timeoutMs: 30_000,
    });
    c.check("/budget set: warn mode default", true);

    // T2 — book spend under warn.
    await rig.submitUntil(
      "Reply with just the word banana in lowercase.",
      () => snapshot(s.dbPath).decisions >= 2 && snapshot(s.dbPath).spent > 0,
      { timeoutMs: 120_000 },
    );
    const afterT2 = snapshot(s.dbPath);
    c.check("T2: spend recorded in ledger", afterT2.spent > 0, `spent=$${afterT2.spent}`);

    await rig.submitUntil("/budget", /of \$0\.02 \(\d+%\) · remaining/, { timeoutMs: 30_000 });
    c.check("/budget: status shows spend + warn mode", /mode warn/.test(rig.text()), "status line");

    // Tighten the limit BELOW observed spend (dynamic — deterministic exhaustion),
    // then flip to enforce. Refusal happens at the exhausted gate, pre-spend.
    const tight = Math.max(afterT2.spent * 0.5, 0.00005).toFixed(5);
    await rig.submitUntil(`/budget set ${tight}`, /Budget set: \$0\.00 \(warn mode\)/, {
      timeoutMs: 30_000,
    });
    await rig.submitUntil("/budget mode enforce", /Budget mode: enforce/, { timeoutMs: 30_000 });
    c.check("/budget mode enforce", true);

    await rig.submitUntil("Reply with just the word cherry in lowercase.", /budget exhausted/, {
      timeoutMs: 45_000,
    });
    await Bun.sleep(2_000);
    const afterRefusal = snapshot(s.dbPath);
    c.check("enforce: refusal message rendered", true);
    c.check("enforce: no decision row for the refused prompt",
      afterRefusal.decisions === afterT2.decisions, `decisions=${afterRefusal.decisions}`);
    c.check("enforce: nothing spent on the refused prompt",
      Math.abs(afterRefusal.spent - afterT2.spent) < 1e-9,
      `spent ${afterT2.spent} -> ${afterRefusal.spent}`);

    // Back to warn: exhausted budget only warns, the turn runs.
    await rig.submitUntil("/budget mode warn", /Budget mode: warn/, { timeoutMs: 30_000 });
    await rig.submitUntil(
      "Reply with just the word dragon in lowercase.",
      () => snapshot(s.dbPath).decisions >= 3,
      { timeoutMs: 120_000 },
    );
    c.check("warn: exhausted budget does not block", true);

    // Shadow mode — track-only; the mode itself must persist to the ledger row.
    await rig.submitUntil("/budget mode shadow", /Budget mode: shadow/, { timeoutMs: 30_000 });
    await waitFor(() => snapshot(s.dbPath).mode === "shadow", { timeoutMs: 10_000, what: "mode=shadow" });
    c.check("shadow: budgets.mode persisted as shadow", true);

    // /clear is display-only — agent context must survive it. (/clear renders no
    // confirmation; it follows a completed slash command, so no busy window applies.)
    await rig.submit("/clear");
    await Bun.sleep(1_000);
    await rig.submitUntil(
      "What was the token I asked you to remember earlier in this conversation? Reply with just the token.",
      /ZEBRA42/,
      { timeoutMs: 120_000 },
    );
    await waitFor(() => snapshot(s.dbPath).decisions >= 4, { timeoutMs: 30_000, what: "turn 4" });
    c.check("lock-in: /clear is display-only (context retained across it)", true);

    // /cost — soft: table shape varies with live routing.
    const mCost = rig.mark();
    const sawCost = await rig
      .submitUntil("/cost", /est|actual|savings|per.?turn|model/i, { timeoutMs: 20_000 })
      .then(() => true)
      .catch(() => false);
    c.soft("/cost renders a cost table", sawCost, rig.text().slice(mCost, mCost + 400));

    await rig.submitUntil("/exit", () => rig.exitCode !== null, { timeoutMs: 20_000 });
    const code = await rig.expectExit(15_000);
    c.check("/exit: clean exit 0", code === 0, `exit=${code}`);

    const db = new HarnessDb(s.dbPath);
    const kinds = db.budgetEventKinds();
    c.check("ledger: reserve+reconcile events exist",
      kinds.includes("reserve") && kinds.includes("reconcile"), kinds.join(","));
    c.check("run row closed: status=done", db.latestRun()?.status === "done", db.latestRun()?.status);
    const dec = db.decisions();
    c.check("all persisted turns were server-routed",
      dec.length >= 4 && dec.every((d) => d.routed === "server"),
      JSON.stringify(dec.map((d) => d.routed)));
    db.close();
  } finally {
    saveArtifact(s, "transcript.txt", rig.text());
    rig.kill();
  }
  return c;
}
