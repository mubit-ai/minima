/**
 * F9 — offline fallback → server comes up → /reconnect → routed.
 *
 * Deterministic and provider-cheap: MINIMA_URL points at a local port with nothing
 * listening (recommend fails → offline fallback, turn still runs unrouted), then the
 * mock /v1 server starts on that same port and /reconnect re-reads process.env.MINIMA_URL
 * (config.ts:75) — the next turn routes with the mock's fixed recommendation.
 *
 * NOTE --offline is deliberately NOT used: it sets cfg.minimaUrl='' and, with no
 * MINIMA_URL in the env, /reconnect can never restore a URL — a one-way door.
 */

import { Checks } from "../assert/check.ts";
import { HarnessDb } from "../assert/db.ts";
import { MockMinimaServer } from "../driver/mock_server.ts";
import { PtyRig } from "../driver/rig.ts";
import { MINIMA_BIN, makeScratch, saveArtifact, waitFor } from "../driver/scratch.ts";

function decisionCount(dbPath: string): number {
  try {
    const db = new HarnessDb(dbPath);
    const n = db.decisions().length;
    db.close();
    return n;
  } catch {
    return 0; // DB may not exist yet
  }
}

export async function f9(): Promise<Checks> {
  const c = new Checks("f9_offline_reconnect");
  const s = makeScratch("f9");
  const port = 21000 + Math.floor(Math.random() * 20000);
  const mock = new MockMinimaServer(port);

  const rig = PtyRig.spawn({
    cmd: [MINIMA_BIN],
    cwd: s.repoDir,
    env: { ...s.env, MINIMA_URL: mock.url },
    wallClockMs: 240_000,
  });

  try {
    await rig.expectText(/· ready/, { timeoutMs: 20_000 });
    c.check("startup: TUI ready", true);

    // Turn 1 — server down: offline fallback, turn still runs on the default model.
    await rig.submitUntil(
      "Say the word zebra in lowercase, reply with just that word.",
      /routing offline:/,
      { timeoutMs: 90_000 },
    );
    c.check("offline turn: 'routing offline' banner with reason", true);
    await waitFor(() => decisionCount(s.dbPath) >= 1, { timeoutMs: 90_000, what: "decision row 1" });
    {
      const db = new HarnessDb(s.dbPath);
      const dec = db.decisions();
      c.check("offline turn: decision routed=offline, basis=offline",
        dec[0]!.routed === "offline" && dec[0]!.decision_basis === "offline",
        JSON.stringify({ routed: dec[0]!.routed, basis: dec[0]!.decision_basis }));
      db.close();
    }

    // Server comes up on the SAME url; /reconnect rebuilds the router from env.
    mock.start();
    await rig.submitUntil("/reconnect", /connected!/, { timeoutMs: 30_000 });
    c.check("/reconnect: rebuilt client", true);

    // Turn 2 — routed through the mock.
    await rig.submitUntil(
      "Say the word falcon in lowercase, reply with just that word.",
      () => decisionCount(s.dbPath) >= 2,
      { timeoutMs: 90_000 },
    );
    {
      const db = new HarnessDb(s.dbPath);
      const dec = db.decisions();
      const d2 = dec[1]!;
      c.check("routed turn: routed=server", d2.routed === "server", d2.routed);
      c.check("routed turn: mock's model chosen", d2.chosen_model === "claude-haiku-4-5", d2.chosen_model);
      c.check("routed turn: rec_id came from the mock", d2.rec_id.startsWith("mock-"), d2.rec_id);
      db.close();
    }
    c.check("mock: recommend request carries the flow namespace",
      mock.captured("/v1/recommend").some(
        (r) => (r.body as Record<string, unknown> | null)?.namespace === s.namespace,
      ),
      JSON.stringify(mock.captured("/v1/recommend").map((r) => (r.body as Record<string, unknown>)?.namespace)));
    await waitFor(() => mock.captured("/v1/feedback").length >= 1, {
      timeoutMs: 30_000,
      what: "feedback POST to mock",
    }).then(
      () =>
        c.check("mock: feedback posted for the routed turn",
          mock.captured("/v1/feedback").some((r) =>
            String((r.body as Record<string, unknown> | null)?.recommendation_id ?? "").startsWith("mock-"),
          )),
      () => c.check("mock: feedback posted for the routed turn", false, "no /v1/feedback within 30s"),
    );

    // Clean shutdown.
    await rig.submitUntil("/exit", () => rig.exitCode !== null, { timeoutMs: 20_000 });
    const code = await rig.expectExit(15_000);
    c.check("/exit: clean exit 0", code === 0, `exit=${code}`);
    {
      const db = new HarnessDb(s.dbPath);
      c.check("run row closed: status=done", db.latestRun()?.status === "done", db.latestRun()?.status);
      db.close();
    }
  } finally {
    saveArtifact(s, "transcript.txt", rig.text());
    rig.kill();
    mock.stop();
  }
  return c;
}
