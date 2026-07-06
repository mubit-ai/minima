/**
 * F6 — resume/lineage/crash across three sessions on one DB (live server, cheap turns).
 *
 * S1: plant a token, set a budget, /exit (runs.status=done).
 * S2: /resume <FULL run_id> — asserts parent_run_id lineage AND that rehydration
 *     restores the conversation (token recall), while the budget does NOT carry over
 *     (fresh session:<run_id> scope — documented landmine, locked in here).
 * S3: SIGKILL mid-turn — the orphaned run row stays status='active' (crash marker).
 */

import { Checks } from "../assert/check.ts";
import { HarnessDb } from "../assert/db.ts";
import { PtyRig } from "../driver/rig.ts";
import { makeScratch, saveArtifact, waitFor } from "../driver/scratch.ts";

function db(dbPath: string): HarnessDb {
  return new HarnessDb(dbPath);
}

export async function f6(): Promise<Checks> {
  const c = new Checks("f6_resume_lineage");
  const s = makeScratch("f6");
  const spawn = () =>
    PtyRig.spawn({ cmd: ["minima"], cwd: s.repoDir, env: s.env, wallClockMs: 300_000 });

  // ---- S1: plant state, close cleanly -------------------------------------------------
  let run1 = "";
  {
    const rig = spawn();
    try {
      await rig.expectText(/· ready/, { timeoutMs: 20_000 });
      await rig.submitUntil(
        "Remember this token: GIRAFFE77. Reply with just the word stored in lowercase.",
        () => {
          try {
            const h = db(s.dbPath);
            const n = h.decisions().length;
            h.close();
            return n >= 1;
          } catch {
            return false;
          }
        },
        { timeoutMs: 120_000 },
      );
      await rig.submitUntil("/budget set 0.05", /Budget set: \$0\.05/, { timeoutMs: 30_000 });
      await rig.submitUntil("/exit", () => rig.exitCode !== null, { timeoutMs: 20_000 });
      await rig.expectExit(15_000);
    } finally {
      saveArtifact(s, "s1-transcript.txt", rig.text());
      rig.kill();
    }
    const h = db(s.dbPath);
    const r = h.latestRun();
    h.close();
    run1 = r?.run_id ?? "";
    c.check("S1: run closed (status=done)", r?.status === "done", r?.status);
    c.check("S1: run id captured", run1.length === 36, run1);
  }

  // ---- S2: resume by FULL id — lineage + rehydration + budget-scope reset -------------
  {
    const rig = spawn();
    try {
      await rig.expectText(/· ready/, { timeoutMs: 20_000 });
      await rig.submitUntil(`/resume ${run1}`, () => {
        try {
          const h = db(s.dbPath);
          const rows = h.runs();
          h.close();
          return rows.some((r) => r.parent_run_id === run1);
        } catch {
          return false;
        }
      }, { timeoutMs: 30_000 });
      c.check("S2: /resume created a lineage child (parent_run_id set)", true);

      // Rehydration proof: the resumed conversation must know the planted token.
      await rig.submitUntil(
        "What was the token I asked you to remember earlier? Reply with just the token.",
        /GIRAFFE77/,
        { timeoutMs: 120_000 },
      );
      c.check("S2: rehydrated context recalls the planted token", true);
      // The regex matched STREAMED text — wait for the turn's decision row before the
      // next command, or the /budget keystrokes race the still-busy streaming view.
      await waitFor(() => {
        try {
          const h = db(s.dbPath);
          const n = h.decisions().length;
          h.close();
          return n >= 2;
        } catch {
          return false;
        }
      }, { timeoutMs: 60_000, what: "S2 recall decision row" });

      // Budget-scope lock-in: a new run_id means a fresh budget scope — S1's budget is gone.
      const m = rig.mark();
      await rig.submitUntil("/budget", /No budget set|of \$/, { timeoutMs: 20_000 });
      c.check("S2: LOCK-IN — budget does not carry across /resume (fresh scope)",
        /No budget set/.test(rig.text().slice(m)),
        rig.text().slice(m, m + 300));

      await rig.submitUntil("/exit", () => rig.exitCode !== null, { timeoutMs: 20_000 });
      await rig.expectExit(15_000);
    } finally {
      saveArtifact(s, "s2-transcript.txt", rig.text());
      rig.kill();
    }
  }

  // ---- S3: crash mid-turn — orphaned run row stays 'active' ---------------------------
  {
    const rig = spawn();
    try {
      await rig.expectText(/· ready/, { timeoutMs: 20_000 });
      const h0 = db(s.dbPath);
      const before = h0.runs().length;
      h0.close();
      await rig.submit("Write a haiku about databases.");
      // Give the run a beat to register, then hard-kill mid-flight.
      await waitFor(() => {
        const h = db(s.dbPath);
        const n = h.runs().length;
        h.close();
        return n > before;
      }, { timeoutMs: 20_000, what: "S3 run row" }).catch(() => {});
      await Bun.sleep(1_500);
      rig.kill();
      await Bun.sleep(1_000);
    } finally {
      saveArtifact(s, "s3-transcript.txt", rig.text());
      rig.kill();
    }
    const h = db(s.dbPath);
    const latest = h.latestRun();
    h.close();
    c.check("S3: crashed run stays status='active' (crash marker)",
      latest?.status === "active", latest?.status);
  }

  return c;
}
