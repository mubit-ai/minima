# P3 manual tests — edit guard (snap tags + seen-lines ledger + stale-edit rejection)

Audience: junior SWE, zero prior context. Every command is copy-paste ready. Work through
the scenarios in order — later ones assume the fixtures from "Prerequisites" exist.

## What this feature does (30 seconds)

Every `read` and `grep` tool result now ends with a short content-hash tag like
`[snap:1b9e02aa]` (first 8 hex chars of the file's sha256). Behind it, the harness records
*which lines of which file, at which hash, this session has actually seen* in a SQLite
table (`seen_lines`). When the model calls `edit`, the harness verifies the target:

- file changed since it was read → **rejected** ("stale") with exact re-read ranges;
- lines never seen this session → **rejected** ("unseen") with exact re-read ranges;
- otherwise the edit runs exactly as before.

The rejection message tells the model which ranges to re-read; after re-reading, the same
edit succeeds. Everything is fail-open: no DB, flag off, or any internal error → tools
behave byte-identically to the previous release.

## Prerequisites

1. Build deps once in the P3 worktree:

   ```sh
   cd /Users/eldaru/Mubit/Minima/minima-boost-p3-edit/packages/tui && bun install
   ```

2. Launch the TUI from the playground repo (all scenarios run inside it):

   ```sh
   cd /Users/eldaru/Mubit/Minima/playground_minima && minima-loc --wt minima-boost-p3-edit
   ```

3. The flag: `MINIMA_TUI_EDIT_GUARD` — **default ON**. Escape hatch:

   ```sh
   MINIMA_TUI_EDIT_GUARD=0 minima-loc --wt minima-boost-p3-edit
   ```

4. The SQLite DB lives at `~/.minima-harness/minima.db` (override: `MINIMA_DB_PATH`).
   The ledger query used throughout (shows the evidence rows of the newest run):

   ```sh
   sqlite3 ~/.minima-harness/minima.db "SELECT path, start_line, end_line, substr(file_hash,1,8), tool FROM seen_lines WHERE run_id=(SELECT run_id FROM runs ORDER BY created DESC LIMIT 1) ORDER BY path, start_line;"
   ```

5. Create the fixture files (in a SECOND terminal, from `playground_minima`):

   ```sh
   cd /Users/eldaru/Mubit/Minima/playground_minima
   printf 'alpha\nbeta\ngamma\ndelta\nepsilon\n' > notes.txt
   mkdir -p tagsdir
   printf 'one\nMARKER one\n' > tagsdir/tags_a.txt
   printf 'two\nMARKER two\n' > tagsdir/tags_b.txt
   printf 'three\nMARKER three\n' > tagsdir/tags_c.txt
   ```

Note on reading results: the expected strings below appear in the TOOL RESULT blocks in
the transcript (expand a collapsed tool result if needed). The model may paraphrase around
them; the tool result text itself is the contract.

## Scenario 1 (AC2) — read stamps a snap tag and records evidence

1. In the TUI, prompt (copy-paste):

   ```
   Read notes.txt and tell me what is on line 3.
   ```

2. EXPECTED: the read tool result ends with one extra line of the exact form
   `[snap:xxxxxxxx]` (8 lowercase hex chars), e.g.:

   ```
   5: epsilon
   [snap:9b1c2f44]
   ```

3. HOW TO VERIFY (second terminal):

   ```sh
   shasum -a 256 notes.txt | cut -c1-8
   ```

   must print exactly the 8 chars inside the tag. Then run the ledger query (Prereq 4);
   expect a row like:

   ```
   /Users/eldaru/Mubit/Minima/playground_minima/notes.txt|1|5|9b1c2f44|read
   ```

   (start 1, end 5 = the five lines actually shown; same 8-char hash prefix.)

## Scenario 2 (AC3) — grep stamps an aggregate tag; grep evidence alone allows an edit

1. Prompt:

   ```
   grep for MARKER in tagsdir, then change the exact string "MARKER two" to "MARKER 2" in tagsdir/tags_b.txt. Do not read any file first — go straight from grep to edit.
   ```

2. EXPECTED:
   - the grep tool result ends with a line of the exact form `[snap:xxxxxxxx 3 files]`;
   - the follow-up edit SUCCEEDS with `edited …/tagsdir/tags_b.txt: 1 replacement(s)` —
     no full read of the file happened (the matched line is enough evidence, by the
     intersection rule).

3. HOW TO VERIFY:

   ```sh
   grep 'MARKER 2' tagsdir/tags_b.txt
   ```

   prints `MARKER 2` (edit landed). Ledger query shows `grep` rows for all three files
   covering line 2, and tags_b.txt refreshed by the edit, e.g.:

   ```
   …/tagsdir/tags_a.txt|2|2|<8hex>|grep
   …/tagsdir/tags_b.txt|2|2|<8hex>|edit
   …/tagsdir/tags_c.txt|2|2|<8hex>|grep
   ```

   (If the assistant insisted on reading the file first, the edit still succeeds — re-run
   with a firmer "do not read" prompt to observe the grep-only path.)

## Scenario 3 (AC1 + AC4) — stale rejection, then scripted recovery

1. Re-create the fixture so line numbers are known: (second terminal)

   ```sh
   printf 'alpha\nbeta\ngamma\ndelta\nepsilon\n' > notes.txt
   ```

2. Prompt:

   ```
   Read notes.txt, then wait for my next instruction. Do nothing else.
   ```

3. Out-of-band change (second terminal — this is the "user/git/bash mutated the file"
   case). Capture both hash prefixes while you are here; the rejection message must quote
   them:

   ```sh
   shasum -a 256 notes.txt | cut -c1-8   # this is <old8>
   echo "drift" >> notes.txt
   shasum -a 256 notes.txt | cut -c1-8   # this is <new8>
   ```

4. Prompt:

   ```
   Now change the exact string "beta" to "BETA" in notes.txt using the edit tool.
   ```

5. EXPECTED: the FIRST edit tool result is a rejection with this exact shape (absolute
   path; both 8-hex snaps; the ranges the session had seen):

   ```
   edit: stale file: /Users/eldaru/Mubit/Minima/playground_minima/notes.txt changed since it was read (snap <old8> -> <new8>). re-read these ranges: /Users/eldaru/Mubit/Minima/playground_minima/notes.txt:1-5 then retry the edit.
   ```

   Then (AC4) the model re-reads the named range and the RETRIED edit succeeds:
   `edited /Users/eldaru/Mubit/Minima/playground_minima/notes.txt: 1 replacement(s)`.

6. HOW TO VERIFY:

   ```sh
   cat notes.txt
   ```

   shows `BETA` on line 2 AND the `drift` line still present (exactly one apply, after
   recovery). Cross-check the hashes quoted in the rejection against the two prefixes you
   captured in step 3: `(snap <old8> -> <new8>)` must match them exactly. The ledger query
   now shows a notes.txt row whose hash prefix differs from BOTH (the retried edit
   refreshed the evidence under the post-edit content).

## Scenario 4 (AC5) — schema exists (migration)

1. No TUI needed. Second terminal:

   ```sh
   sqlite3 ~/.minima-harness/minima.db ".schema seen_lines"
   ```

2. EXPECTED (byte-exact output):

   ```
   CREATE TABLE seen_lines (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id     TEXT NOT NULL,
          agent_id   TEXT,
          path       TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line   INTEGER NOT NULL,
          file_hash  TEXT NOT NULL,
          tool       TEXT NOT NULL,
          created    REAL NOT NULL
        );
   CREATE INDEX ix_seen_lines_key ON seen_lines(run_id, path, created);
   ```

## Scenario 5 (AC6) — flag off restores pre-P3 behavior exactly

1. Quit the TUI (`/quit` or ctrl+c twice). Relaunch with the guard off:

   ```sh
   cd /Users/eldaru/Mubit/Minima/playground_minima && MINIMA_TUI_EDIT_GUARD=0 minima-loc --wt minima-boost-p3-edit
   ```

2. Repeat Scenario 3 (re-create notes.txt, read-and-wait, append `drift`, ask for the
   beta→BETA edit).

3. EXPECTED:
   - the read result has NO `[snap:` line;
   - the post-drift edit applies IMMEDIATELY (no rejection, no re-read):
     `edited /Users/eldaru/Mubit/Minima/playground_minima/notes.txt: 1 replacement(s)`.

4. HOW TO VERIFY: the ledger query returns ZERO rows for this run (the newest run wrote
   nothing to seen_lines).

## Scenario 6 (AC7) — the benchmark is a normal test gate

1. Second terminal:

   ```sh
   cd /Users/eldaru/Mubit/Minima/minima-boost-p3-edit/packages/tui && bun test tests/edit-bench.test.ts
   ```

2. EXPECTED: 3 pass / 0 fail, with these summary lines in the output (hard-asserted
   thresholds — pass means zero regression on legitimate edits and 100% stale recall):

   ```
   edit-bench legit: ON 12/12, OFF 12/12
   edit-bench stale: rejected ON 4/4, applied OFF 4/4
   edit-bench recovery: ON reject->re-read->retry ok, OFF parity ok
   ```

## Teardown / reset

```sh
cd /Users/eldaru/Mubit/Minima/playground_minima
rm -f notes.txt
rm -rf tagsdir
```

The `seen_lines` rows are keyed by run id and are inert once a session ends — no cleanup
required. To wipe them anyway (safe; affects only this feature's evidence):

```sh
sqlite3 ~/.minima-harness/minima.db "DELETE FROM seen_lines;"
```

To temporarily disable the whole feature at any time: launch with
`MINIMA_TUI_EDIT_GUARD=0` (Prereq 3).
