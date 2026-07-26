# Manual test guide — P1 artifact spill store

> Feature branch: `feat/boost-p1-artifacts` (worktree
> `/Users/eldaru/Mubit/Minima/minima-boost-p1-artifacts`). Spec:
> `docs/boosting/p1-artifacts-plan.md`. No prior context needed — every step is
> copy-paste.

## What this feature does (30 seconds)

When a tool produces more output than fits in the model's view (bash > 50 000 chars;
grep > 200 matches; glob > 200 results; ls > 500 entries), the full output used to be
simply lost. Now the harness saves it to a content-addressed file
`~/.minima-harness/artifacts/<sha256>.txt`, records an index row in SQLite, and the
truncation notice names the absolute path so the model (or you) can page it back with
the normal `read` tool.

## Prerequisites

1. The worktree with the feature:

   ```bash
   cd /Users/eldaru/Mubit/Minima/minima-boost-p1-artifacts/packages/tui && bun install
   ```

2. Launch the TUI from this worktree's source (no build step):

   ```bash
   cd /Users/eldaru/Mubit/Minima/playground_minima
   minima-loc --wt minima-boost-p1-artifacts
   ```

3. **Flag**: the feature is ON by default. The escape hatch is the env var
   `MINIMA_TUI_ARTIFACTS=0` (used in scenario 5).

4. **Where things live on your machine**:
   - artifact files: `~/.minima-harness/artifacts/<sha256>.txt`
   - SQLite DB (index table `artifacts`): `~/.minima-harness/minima.db`

5. Optional pre-flight — note the current artifact count so later diffs are obvious:

   ```bash
   ls ~/.minima-harness/artifacts 2>/dev/null | wc -l
   ```

## Scenario 1 (AC1) — huge bash output lands a ref

In the TUI, prompt exactly:

```
Run exactly this bash command: awk 'BEGIN { for (i=0;i<20000;i++) printf "line %06d abcdefghijklmnopqrstuvwxyz\n", i }'
```

**Expected on screen** (inside the bash tool result):

- head lines starting at `line 000000 abcdefghijklmnopqrstuvwxyz`
- an omission marker line, byte-exact: `[... 730064 chars omitted ...]`
  (the awk output is 780 000 chars; the visible body keeps the first 10 000 and the
  last 39 936)
- tail lines ending at `line 019999 abcdefghijklmnopqrstuvwxyz`
- `[exit 0]`
- a final line, byte-exact (replace `<you>` with your username):
  `[full output saved: /Users/<you>/.minima-harness/artifacts/98fa0134d62790f68a87013e1054ccdfa947f9922752a7144b854dd0cf040723.txt]`

The awk output is deterministic, so the sha256 is always
`98fa0134d62790f68a87013e1054ccdfa947f9922752a7144b854dd0cf040723`.

**Verify**:

```bash
wc -l ~/.minima-harness/artifacts/98fa0134d62790f68a87013e1054ccdfa947f9922752a7144b854dd0cf040723.txt
# → 20000
wc -c ~/.minima-harness/artifacts/98fa0134d62790f68a87013e1054ccdfa947f9922752a7144b854dd0cf040723.txt
# → 780000
sqlite3 ~/.minima-harness/minima.db "SELECT tool_name, bytes, line_count FROM artifacts ORDER BY created DESC LIMIT 1;"
# → bash|780000|20000
```

## Scenario 2 (AC2) — the model pages the saved file back with read

Follow-up prompt in the same session:

```
Read lines 9000 to 9010 of that saved file.
```

**Expected**: the model calls the `read` tool on the artifact path from scenario 1 and
the tool result shows numbered lines matching the awk output:

```
 9000: line 008999 abcdefghijklmnopqrstuvwxyz
 ...
 9010: line 009009 abcdefghijklmnopqrstuvwxyz
```

(1-based numbering, so line 9000 contains `line 008999`.)

**Verify** against the file directly:

```bash
sed -n '9000p;9010p' ~/.minima-harness/artifacts/98fa0134d62790f68a87013e1054ccdfa947f9922752a7144b854dd0cf040723.txt
# → line 008999 abcdefghijklmnopqrstuvwxyz
# → line 009009 abcdefghijklmnopqrstuvwxyz
```

## Scenario 3 (AC3) — grep truncation notice carries the ref

Prompt:

```
grep for "import" across this repo
```

**Expected**: the grep tool result ends with a line of the form

```
[output truncated: showing first 200 of N matches]; full output saved: /Users/<you>/.minima-harness/artifacts/<sha>.txt
```

(N = total matches in the repo, > 200. The `<sha>` here differs from scenario 1 —
different content, different hash.)

**Verify** the ref file holds matches beyond the 200 shown:

```bash
# paste the exact path from the notice:
wc -l <ref>          # > 200
sed -n '201,205p' <ref>   # real matches past the visible cutoff
sqlite3 ~/.minima-harness/minima.db "SELECT tool_name, line_count FROM artifacts ORDER BY created DESC LIMIT 1;"
# → grep|<same count as wc -l>
```

## Scenario 4 (AC4) — schema present; re-run dedupes, bumps last_used

**Verify the schema**:

```bash
sqlite3 ~/.minima-harness/minima.db ".schema artifacts"
# → CREATE TABLE artifacts ( sha TEXT PRIMARY KEY, path TEXT NOT NULL, run_id TEXT,
#   tool_name TEXT, bytes INTEGER NOT NULL, line_count INTEGER NOT NULL,
#   created REAL NOT NULL, last_used REAL NOT NULL )
# → CREATE INDEX ix_artifacts_run ON artifacts(run_id, created)
```

Record the current state:

```bash
ls ~/.minima-harness/artifacts | wc -l
sqlite3 ~/.minima-harness/minima.db "SELECT created, last_used FROM artifacts WHERE sha='98fa0134d62790f68a87013e1054ccdfa947f9922752a7144b854dd0cf040723';"
```

Repeat the scenario-1 prompt (same awk command). **Expected**:

- the saved-line shows the SAME path (same sha — content addressing)
- `ls ~/.minima-harness/artifacts | wc -l` is unchanged (no duplicate file)
- re-running the sqlite query shows `created` unchanged and `last_used` increased

## Scenario 5 (AC5) — flag off restores pre-P1 behavior

Quit the TUI, note the artifact count, and relaunch with the flag off:

```bash
ls ~/.minima-harness/artifacts | wc -l    # remember this number
cd /Users/eldaru/Mubit/Minima/playground_minima
MINIMA_TUI_ARTIFACTS=0 minima-loc --wt minima-boost-p1-artifacts
```

Re-run the scenario-1 prompt. **Expected**:

- output is the pre-P1 shape: head + `[... N chars omitted ...]` + tail + `[exit 0]`
  and NO `[full output saved: …]` line
- grep/glob/ls truncation notices end at `… matches]` with no `; full output saved:` suffix

**Verify** no new files appeared:

```bash
ls ~/.minima-harness/artifacts | wc -l    # same number as before
sqlite3 ~/.minima-harness/minima.db "SELECT COUNT(*) FROM artifacts;"  # unchanged since scenario 4
```

## Teardown / reset

Artifacts are plain files plus index rows — safe to clear at any time (the feature
recreates the directory on next use; nothing else references the rows):

```bash
rm -rf ~/.minima-harness/artifacts
sqlite3 ~/.minima-harness/minima.db "DELETE FROM artifacts;"
```

Do NOT delete `~/.minima-harness/minima.db` itself (it holds all session history) and
do not touch `~/.minima-harness/blobs/` (the separate v13 internal persistence tier).
