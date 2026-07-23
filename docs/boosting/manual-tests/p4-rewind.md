# P4 manual tests — checkpoint/rewind context pruning

Feature under test: a model-callable `checkpoint` / `rewind(report)` tool pair. The model
sets a checkpoint before an exploration burst; a later `rewind` prunes everything between
the checkpoint and the rewind from the model's WORKING CONTEXT, keeping only the model's
report. The SQLite ledger keeps every pruned row (nothing is ever deleted), and a
`context_rewind` event row makes the prune survive restart/`/resume`.

## Prerequisites

- Worktree: `/Users/eldaru/Mubit/Minima/minima-boost-p4-rewind` (branch `feat/boost-p4-rewind`).
- One-time setup:

  ```bash
  cd /Users/eldaru/Mubit/Minima/minima-boost-p4-rewind/packages/tui && bun install
  ```

- Launch (all interactive scenarios):

  ```bash
  cd /Users/eldaru/Mubit/Minima/playground_minima && minima-loc --wt minima-boost-p4-rewind
  ```

- Feature flag: `MINIMA_TUI_REWIND`. Default ON. Escape hatch: prefix the launch with
  `MINIMA_TUI_REWIND=0` to unregister the two tools (scenario 4). The flag gates tool
  REGISTRATION only — replay of already-persisted markers is honored regardless.
- Session DB: `~/.minima-harness/minima.db` by default; set `MINIMA_DB_PATH=/tmp/p4.db`
  before launching to keep this test run isolated (recommended). Every query below uses
  `$DB`; set it to whichever path applies:

  ```bash
  export DB=~/.minima-harness/minima.db   # or /tmp/p4.db
  ```

- The events query used throughout (latest run's rows, oldest first):

  ```bash
  sqlite3 "$DB" "SELECT type, substr(payload,1,60) FROM events WHERE run_id=(SELECT run_id FROM runs ORDER BY created DESC LIMIT 1) ORDER BY ts"
  ```

## Scenario 1 (AC1) — rewind prunes the projection, the ledger keeps everything

1. Launch the TUI. Paste exactly:

   ```
   Call the checkpoint tool. Then use the read tool on package.json and on README.md. Then call rewind with report: "REPORT-MARKER: bun monorepo, tui package holds the harness."
   ```

2. EXPECTED on screen, in order:
   - a `checkpoint` tool call whose result is `Checkpoint set` (or `Checkpoint set: <label>`
     if the model passed a label);
   - two `read` tool results showing file contents;
   - a `rewind` tool result beginning exactly with:

     ```
     Context rewound to checkpoint. Pruned tool traffic is preserved in the session ledger.
     ```

     followed by a blank line, `Report:`, and the report text containing `REPORT-MARKER:`.

   If the model batches checkpoint and rewind into ONE turn it will hit the guard of
   scenario 3b instead — re-prompt it one step at a time.

3. Then paste the probe:

   ```
   Quote verbatim any tool output from before your rewind.
   ```

   EXPECTED: the model can only cite the checkpoint confirmation ("Checkpoint set") and
   its own report text. A correct answer states it no longer has the file contents (or
   quotes only fragments its own report happened to contain). FAILURE looks like the
   model quoting actual `package.json`/`README.md` contents (e.g. the `"name"` /
   `"version"` JSON fields or README headings) — that means the prune did not happen.

4. HOW TO VERIFY in the ledger — run the events query from Prerequisites. EXPECTED rows
   include, in this relative order: `tool` rows for BOTH `read` calls (payloads showing
   file content snippets — the ledger kept the pruned traffic), then one `context_rewind`
   row, then a `tool` row for the rewind result. Also:

   ```bash
   sqlite3 "$DB" "SELECT COUNT(*) FROM events WHERE type='context_rewind' AND run_id=(SELECT run_id FROM runs ORDER BY created DESC LIMIT 1)"
   ```

   EXPECTED: `1`. The marker payload carries `anchor_tool_call_id`, `rewind_tool_call_id`,
   the (bounded) `report`, and `report_chars`.

## Scenario 2 (AC2) — the prune survives restart and /resume

1. Immediately after scenario 1, quit the TUI (Ctrl+C).
2. Relaunch with the same command (same `MINIMA_DB_PATH` if you set one), then run
   `/resume` and pick the scenario-1 session.
3. Paste the same probe:

   ```
   Quote verbatim any tool output from before your rewind.
   ```

   EXPECTED: same behavior as scenario 1 step 3 — the file contents did NOT come back
   after the restart (the `context_rewind` marker was re-applied during replay).
4. HOW TO VERIFY: re-run the events query against the ORIGINAL run (it is no longer the
   latest run after the relaunch, so list runs first):

   ```bash
   sqlite3 "$DB" "SELECT run_id, display_name, created FROM runs ORDER BY created DESC LIMIT 5"
   sqlite3 "$DB" "SELECT type, substr(payload,1,60) FROM events WHERE run_id='<scenario-1 run_id>' ORDER BY ts"
   ```

   EXPECTED: every row from scenario 1 is still present — both `read` tool rows AND the
   `context_rewind` row. Replay prunes the projection only; it never deletes rows.

## Scenario 3 (AC3) — guard rails

a. Fresh session (relaunch, or just continue in a NEW session). Paste:

   ```
   Call rewind now with report "x".
   ```

   EXPECTED: a visible tool ERROR containing:

   ```
   no active checkpoint — call checkpoint before rewind
   ```

   (the full message also names context compaction as a possible cause). VERIFY no marker
   was written:

   ```bash
   sqlite3 "$DB" "SELECT COUNT(*) FROM events WHERE type='context_rewind' AND run_id=(SELECT run_id FROM runs ORDER BY created DESC LIMIT 1)"
   ```

   EXPECTED: `0`.

b. Same-turn batch. Paste:

   ```
   In one single response, call both the checkpoint tool and the rewind tool (report "too soon") together.
   ```

   EXPECTED: checkpoint succeeds; rewind errors with a message containing
   `checkpoint has not committed yet` (the anchor only lands when the turn ends). The
   marker count query above still returns `0` for this session.

c. Consume rule. In one session, step by step: have it call `checkpoint`, then one `read`
   of `package.json`, then `rewind` with report "first" — this succeeds. Then paste:

   ```
   Call rewind again with report "second".
   ```

   EXPECTED: an error containing `already consumed by a previous rewind` and
   `set a fresh checkpoint`. Marker count for the session stays `1`.

## Scenario 4 (AC4) — flag off unregisters the tools

1. Launch with the flag off:

   ```bash
   cd /Users/eldaru/Mubit/Minima/playground_minima && MINIMA_TUI_REWIND=0 minima-loc --wt minima-boost-p4-rewind
   ```

2. Paste:

   ```
   Call the checkpoint tool.
   ```

   EXPECTED: the transcript shows the dispatcher's error result
   `Unknown tool: checkpoint` (the model may then apologize/improvise — the load-bearing
   part is the Unknown tool error, which proves the tools were never registered).
3. Replay is NOT gated: a session that already contains a `context_rewind` row (scenario 1)
   still resumes pruned even under `MINIMA_TUI_REWIND=0` — repeat scenario 2's probe with
   the flag off to confirm.

## Scenario 5 (AC5) — schema pin is additive-only (dev gate, no TUI)

```bash
cd /Users/eldaru/Mubit/Minima/minima-boost-p4-rewind/packages/tui
bun test tests/tool-schemas.test.ts
git diff origin/feat/boosting -- tests/__snapshots__/tool-schemas.test.ts.snap
```

EXPECTED: the test file passes; the snapshot diff shows ONLY added lines (two new
`checkpoint` / `rewind` entries; zero deletions — every pre-existing entry byte-identical).

## Teardown / reset

- If you used `MINIMA_DB_PATH=/tmp/p4.db`: `rm -f /tmp/p4.db*` (also removes `-wal`/`-shm`).
- If you used the default DB, the test sessions are ordinary runs; nothing to clean.
  To remove them anyway, delete nothing by hand in SQLite — just ignore them (the ledger
  is append-only by design) or move the whole file aside if you want a truly fresh slate:
  `mv ~/.minima-harness/minima.db ~/.minima-harness/minima.db.bak`.
- `unset DB MINIMA_DB_PATH MINIMA_TUI_REWIND` in the shell you exported them.
