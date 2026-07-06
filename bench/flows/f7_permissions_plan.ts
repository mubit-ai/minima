/**
 * F7 — permission overlays, plan mode, and the /undo //fork //clone stub lock-ins
 * (live server, py-cli fixture, cheap single-tool turns).
 *
 * Overlay mechanics under test (permissions.ts): READS PROMPT EVEN WITHIN CWD (the
 * app.tsx:565 comment says "read/ls auto-allow within cwd" but allowedDirs starts
 * empty — locked in below); 'a' on a read = grant that directory; write/edit/bash
 * always prompt; 'a' on edit = tool-global always-allow; deny renders
 * "Permission denied for <tool>". Known-broken commands are asserted AS broken.
 *
 * Driver: each turn carries an ordered ANSWER PLAN. An answer keypress is retried
 * until its observable EFFECT appears (deny text, disk change, content in transcript) —
 * naive single keypresses race the overlay lifecycle (an instant model retry can
 * repaint a new overlay inside the same poll window and get missed).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checks } from "../assert/check.ts";
import { HarnessDb } from "../assert/db.ts";
import { materialize } from "../gen/materialize.ts";
import { PtyRig } from "../driver/rig.ts";
import { makeScratch, saveArtifact, waitFor } from "../driver/scratch.ts";

function leadDecisions(dbPath: string): number {
  try {
    const db = new HarnessDb(dbPath);
    const n = db.decisions().filter((d) => !d.agent_id).length;
    db.close();
    return n;
  } catch {
    return 0;
  }
}

interface PlannedAnswer {
  key: "y" | "a" | "n";
  /** Observable consequence of the answer (searched since just before the keypress). */
  effect: RegExp | (() => boolean);
  /** Reuse this answer for any further overlays in the same turn. */
  repeat?: boolean;
}

const OVERLAY_RE = /\[y\] Yes once/;

/**
 * Submit a prompt and baby-sit the turn: answer overlays per `plan` (retrying each
 * keypress until its effect lands), until the lead decision count reaches `target`.
 * Returns the number of overlays answered.
 */
async function overlaySession(
  rig: PtyRig,
  dbPath: string,
  prompt: string,
  plan: PlannedAnswer[],
  target: number,
  timeoutMs = 240_000,
): Promise<number> {
  let baseline = rig.mark();
  await rig.submitUntil(prompt, () =>
    OVERLAY_RE.test(rig.text().slice(baseline)) || leadDecisions(dbPath) >= target,
  { timeoutMs: 90_000 });
  let answered = 0;
  let planIdx = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (leadDecisions(dbPath) >= target) return answered;
    if (OVERLAY_RE.test(rig.text().slice(baseline))) {
      const item = plan[Math.min(planIdx, plan.length - 1)];
      if (!item || (planIdx >= plan.length && !plan[plan.length - 1]?.repeat)) {
        throw new Error(`unplanned overlay #${answered + 1}; tail:\n${rig.text().slice(-1200)}`);
      }
      const effectSeen = () =>
        item.effect instanceof RegExp
          ? item.effect.test(rig.text().slice(preAnswer))
          : item.effect();
      const preAnswer = rig.mark();
      let ok = false;
      for (let tries = 0; tries < 5 && !ok; tries++) {
        rig.write(item.key);
        const until = Date.now() + 3_000;
        while (Date.now() < until) {
          if (effectSeen() || leadDecisions(dbPath) >= target) {
            ok = true;
            break;
          }
          await Bun.sleep(150);
        }
      }
      if (!ok) throw new Error(`overlay answer '${item.key}' produced no effect; tail:\n${rig.text().slice(-1200)}`);
      answered++;
      planIdx++;
      baseline = rig.mark();
      continue;
    }
    await Bun.sleep(200);
  }
  throw new Error(`overlaySession timeout (answered ${answered}); tail:\n${rig.text().slice(-1200)}`);
}

export async function f7(): Promise<Checks> {
  const c = new Checks("f7_permissions_plan");
  const s = makeScratch("f7");
  const work = join(s.root, "workrepo");
  await materialize("bench/tasks/py-cli/pc-001", work, { applyBug: false });
  writeFileSync(join(s.root, "secret.txt"), "the secret word is MANGO55\n", "utf8");
  const modelsPy = join(work, "taskman", "models.py");

  const rig = PtyRig.spawn({ cmd: ["minima"], cwd: work, env: s.env, wallClockMs: 600_000 });
  let turns = 0;

  try {
    await rig.expectText(/· ready/, { timeoutMs: 20_000 });

    // 1. Outside-cwd read prompts; 'y' (once) lets it through.
    const o1 = await overlaySession(rig, s.dbPath,
      "Read the file ../secret.txt and tell me the secret word it contains.",
      [{ key: "y", effect: /MANGO55/, repeat: true }], ++turns);
    c.check("read outside cwd: overlay prompted", o1 >= 1, `overlays=${o1}`);
    c.check("read outside cwd: content returned after [y]", /MANGO55/.test(rig.text()));

    // 2. LOCK-IN: reads prompt even INSIDE cwd (allowedDirs starts empty despite the
    //    "auto-allow within cwd" code comment). Grant the repo dirs with 'a'.
    const o2 = await overlaySession(rig, s.dbPath,
      "Read the first line of taskman/models.py and the first line of README.md, and tell me both.",
      [{ key: "a", effect: () => true, repeat: true }], ++turns);
    c.check("LOCK-IN: in-cwd reads still prompt (granted with [a])", o2 >= 1, `overlays=${o2}`);

    // 3. Edit denied: file must stay untouched, deny message must render.
    const before = readFileSync(modelsPy, "utf8");
    const o3 = await overlaySession(rig, s.dbPath,
      "Using your edit tool, add the comment line '# bench-f7' at the very top of taskman/models.py.",
      [{ key: "n", effect: /Permission denied for/, repeat: true }], ++turns);
    c.check("edit deny: overlay prompted", o3 >= 1, `overlays=${o3}`);
    c.check("edit deny: 'Permission denied' rendered", /Permission denied for edit/.test(rig.text()));
    c.check("edit deny: file untouched", readFileSync(modelsPy, "utf8") === before);

    // 4. Same ask, 'a' = always-allow the edit tool: change lands on disk.
    await overlaySession(rig, s.dbPath,
      "Please retry now: add the comment line '# bench-f7' at the very top of taskman/models.py.",
      [{ key: "a", effect: () => readFileSync(modelsPy, "utf8").includes("# bench-f7"), repeat: true }],
      ++turns);
    c.check("edit allow-always: change landed",
      readFileSync(modelsPy, "utf8").includes("# bench-f7"));

    // 5. Next edit: NO overlay (tool-global grant).
    const o5 = await overlaySession(rig, s.dbPath,
      "Add the comment line '# bench-f7-second' directly under the first comment in taskman/models.py.",
      [], ++turns).catch((e) => {
      // An unplanned overlay here means the always-grant didn't stick — surface as -1.
      return String(e).includes("unplanned overlay") ? -1 : Promise.reject(e);
    });
    c.check("allow-always: subsequent edit ran with NO overlay", o5 === 0, `overlays=${o5}`);
    c.check("allow-always: second change landed",
      readFileSync(modelsPy, "utf8").includes("# bench-f7-second"));

    // 6. LOCK-IN: /undo claims success but reverts nothing (bare `git checkout --`).
    await rig.submitUntil("/undo", /Reverted changes to/, { timeoutMs: 20_000 });
    c.check("LOCK-IN /undo: success message despite reverting nothing",
      readFileSync(modelsPy, "utf8").includes("# bench-f7"),
      "file no longer has the marker — /undo may have been fixed; update this lock-in");

    // 7. Plan mode blocks writes; file stays put.
    await rig.submitUntil("/plan", /Plan mode ON — read-only/, { timeoutMs: 20_000 });
    const planBefore = readFileSync(modelsPy, "utf8");
    await overlaySession(rig, s.dbPath,
      "Append the comment '# bench-f7-plan' at the top of taskman/models.py.",
      [{ key: "y", effect: () => true, repeat: true }], ++turns);
    c.check("plan mode: write blocked (file unchanged)",
      readFileSync(modelsPy, "utf8") === planBefore);
    await rig.submitUntil("/plan", /Plan mode OFF — full write access restored/, { timeoutMs: 20_000 });

    // 8. LOCK-INs: /fork and /clone print success without doing anything.
    const runsBefore = (() => {
      const db = new HarnessDb(s.dbPath);
      const n = db.runs().length;
      db.close();
      return n;
    })();
    await rig.submitUntil("/fork", /Forked session successfully/, { timeoutMs: 20_000 });
    await rig.submitUntil("/clone", /Cloned session successfully/, { timeoutMs: 20_000 });
    const runsAfter = (() => {
      const db = new HarnessDb(s.dbPath);
      const n = db.runs().length;
      db.close();
      return n;
    })();
    c.check("LOCK-IN /fork //clone: fake success, no new runs",
      runsAfter === runsBefore, `runs ${runsBefore} -> ${runsAfter}`);

    await rig.submitUntil("/exit", () => rig.exitCode !== null, { timeoutMs: 20_000 });
    const code = await rig.expectExit(15_000);
    c.check("/exit: clean exit 0", code === 0, `exit=${code}`);
  } finally {
    saveArtifact(s, "transcript.txt", rig.text());
    rig.kill();
  }
  return c;
}
