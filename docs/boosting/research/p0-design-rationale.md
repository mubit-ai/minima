# P0 design rationale — tool-layer hardening

> Designed 2026-07-22 against `feat/boosting` = 54fcb68. Evidence base:
> `tui-tool-audit.md`. Execution order (Wave 0 → Wave 1), gates, and tracking live in
> `../boosting-roadmap.md` — this doc is the per-tool behavioral contract, the test matrix,
> and the why behind each choice. Zero new deps; Bun APIs only; schemas unchanged except one
> additive glob param.

## The seam (Wave 0, frozen before fan-out)

### `src/tools/_bounds.ts` — the ONE bounded-output helper

```ts
export interface BoundedOutput {
  body: string;          // capped text, elision marker inline for headTail
  notice: string | null; // standardized trailer, null when not truncated
  truncated: boolean;
  totalLines: number;
  shownLines: number;
  totalChars: number;
}

export interface BoundOpts {
  maxLines?: number;           // default Infinity
  maxChars?: number;           // default 50_000
  unit?: string;               // "lines" (default) | "matches" | "entries"
  keep?: "head" | "headTail";  // default "head"
  headChars?: number;          // headTail only, default 10_000
  totalIsLowerBound?: boolean; // scan stopped early → "N+" in notice
  spill?: SpillSink | null;    // P1 seam — unused in P0
}
export type SpillSink = (full: string) => { ref: string } | null;

export function boundText(full: string, opts?: BoundOpts): BoundedOutput;
export function boundDetails(b: BoundedOutput): Record<string, unknown>;
// → { truncated, total_lines, shown_lines } merged into each tool's details

export class BoundedBuffer {   // streaming accumulator (bash)
  constructor(opts?: { maxChars?: number; headChars?: number });
  push(chunk: string): void;   // head prefix + tail ring; evicts middle; O(cap) memory
  snapshot(): string;          // current bounded view (for onUpdate)
  finish(): BoundedOutput;
}
```

Truncation contract (exact model-visible strings — tests assert these):

- `keep:"head"`: body = first N whole lines/chars; notice =
  `[output truncated: showing first {shown} of {total}{+} {unit}]`, appended by the caller as
  `` `${body}\n${notice}` ``.
- `keep:"headTail"` (bash): body = `head + "\n[... {elidedChars} chars omitted ...]\n" + tail`;
  notice = null (inline marker suffices). Cuts at line boundaries when possible.
- **Cap interaction** (pinned BEFORE the freeze — the seam must not discover this in Wave 1):
  `maxLines` and `maxChars` compose — emit whole lines until adding the next line would exceed
  EITHER cap; `shownLines` = whole lines emitted; the notice always reports shown/total in
  `unit`, regardless of which cap bound first. A single line longer than `maxChars` with no
  interior boundary is hard-cut at `maxChars` mid-line and still counts as one shown line
  (grep can't hit this — per-line pre-truncation at 2000 chars; bash uses headTail where the
  inline marker handles it). headTail budgets: `headChars` for the head, `maxChars − headChars
  − marker` for the tail; cuts prefer line boundaries, falling back to hard cuts.
- **P1 slot-in**: when `spill` is provided and truncation happens, the helper calls it with the
  full text and appends `"; full output saved: {ref}"` to the notice, adding `spill_ref` to
  `boundDetails`. Tools already route everything through the helper, so P1 wires an
  artifact-store `SpillSink` into the tool factories and touches only `_bounds.ts` +
  `builtin.ts` — zero per-tool edits. This seam is WHY every tool must adopt the helper in P0.

### `src/tools/_rg.ts` — shared ripgrep resolution

```ts
export function resolveRg(override?: string | null): string | null;
// null → force fallback (tests) · string → explicit binary (tests)
// undefined → cached Bun.which("rg")
```

Replaces spawn-throws-ENOENT detection with an upfront `Bun.which` check (still graceful when
rg is absent). `grepTool`/`globTool` opts widen to `FsToolOptions & { rgCmd?: string | null }` —
a TS-only test seam, not model-visible; `builtinTools` passes nothing.

## Per-tool contracts

### grep (`src/tools/grep.ts`) — Wave 0 consumer

Extract exported `buildRgArgs(params)` / `buildGrepArgs(params)` (pure, unit-testable; exact
input shape is implementer's choice — G2 asserts flag presence/absence only).

- rg args: `["-n", "--no-heading", "--color=never", "--sort", "path"]` — **`-N` removed**
  (line numbers restored), `--sort path` for deterministic ordering. `-i` when
  `case_insensitive`, `-g <glob>` when `glob`, then `["--", pattern, path]`.
- Fallback args: `["-rnsI", "--exclude-dir=.git", "--exclude-dir=node_modules"]`
  (+`-i`, +`--include <glob>`) — `-s` silences unreadable-file noise, `-I` skips binaries;
  exclude-dirs approximate the ignore claim (BSD + GNU grep both support all three).
- Exit 2 with non-empty stdout: return bounded matches + trailer
  `[note: some paths could not be searched]` instead of discarding results; exit 2 with empty
  stdout stays `errorResult`.
- Per-line 2000-char cap via `truncateLine` before bounding.
- Bounding: `boundText(joined, { maxLines: 200, maxChars: 50_000, unit: "matches" })`;
  details = `{ count: totalLines, ...boundDetails(b) }` (count becomes TOTAL, was shown —
  zero consumers in src/, verified).
- Description (honest): "Search file contents (ripgrep if available, else grep). Returns
  file:line:content matches. .gitignore respected when ripgrep is available. Use 'glob' to
  filter file types. Max 200 matches shown."

### glob (`src/tools/glob.ts`) — Wave 1

Engine decision: **hybrid — `rg --files` for the file list, `Bun.Glob.match` for pattern
semantics.** Rationale: passing the user pattern to `rg -g` silently changes semantics
(`*.ts` becomes any-depth); filtering rg's list through `Bun.Glob(pattern).match(relPath)`
keeps today's exact pattern behavior on both engines while getting gitignore for free.

- Schema: ONE additive param `include_ignored` (boolean, default false, description
  "Include files ignored by .gitignore (and node_modules).").
- rg path (default): `[rg, "--files"]` with `cwd`; filter lines through
  `Bun.Glob(normalizedPattern).match(line)` (strip leading `./` from the pattern).
- Fallback or `include_ignored=true`: `Bun.Glob.scan({ cwd, dot: include_ignored,
  followSymlinks: false, throwErrorOnBrokenSymlink: false, onlyFiles: true })`.
- Uniform TS-side exclusion on BOTH engines (unless `include_ignored`): drop paths containing a
  `node_modules/` or `.git/` segment — normalizes rg's "node_modules only if gitignored".
- Determinism: collect to a 10_000 scan ceiling (then `totalIsLowerBound`), **sort the full
  set, then** `boundText(..., { maxLines: 200, unit: "matches", totalIsLowerBound })` —
  fixes cap-before-sort and the silent cap.
- Zero matches on the rg path: append hint
  `(no matches — note: .gitignore'd files are excluded; set include_ignored=true to search them)`.
- Description updated to match.

### read (`src/tools/read.ts` + `src/tools/_io.ts`) — Wave 1

- One `await stat` try/catch replaces `existsSync`/`statSync`; missing-file/is-directory error
  messages keep their EXACT current text (existing tests assert them).
- Binary guard: NUL byte in the first 8KB (`Bun.file(p).slice(0, 8192)`) →
  `errorResult("read: binary file (<size> bytes): <path> — use bash to inspect binary content")`.
  Image extensions (`.png .jpg .jpeg .gif .webp .bmp .ico`) →
  `errorResult("read: image file not supported yet: <path>")` (returning ImageContent is
  deferred — provider tool-result image support unverified across the three conversions).
- `readLines` rewritten to stream: `Bun.file(path).stream()` + `TextDecoder({stream:true})`,
  incremental line split, skip to `offset`, stop after `offset+limit`, cancel the reader
  (a 2GB log read at offset 1 touches only the first window). Current-line accumulation
  discards beyond `MAX_LINE+1` chars (O(MAX_LINE) memory even for a newline-free giant file).
  Scan ceiling 100MB before the window completes → body ends
  `…(stopped after 100MB scanned; file too large for this offset)`.
- Output format **byte-identical** for normal cases (same padding, same
  `…(N more lines; use a larger offset to continue)` trailer) — existing read tests stay green
  unmodified. Signature `(path, {offset, limit}) → {body, n}` unchanged.
- Backstop: body > 200_000 chars → drop trailing lines +
  `…(output capped at 200000 chars; use offset/limit)`. (Not via boundText — read's
  offset/limit continuation contract is richer; this is only a backstop.)

### ls (`src/tools/ls.ts`) — Wave 1

- Fully async: `await stat(root)` try/catch (`ls: no such path` on ENOENT, NEW
  `ls: not a directory` when target is a file — old code threw raw ENOTDIR).
- `readdir(root, { withFileTypes: true })`; symlinks resolved with try/catch — a dangling
  symlink lists as a plain file, never throws. No per-entry stat for regular entries (kills
  the N-stat syscall storm).
- Sort unchanged (dirs first, case-insensitive); hidden still included (description already
  promises this). Bound: `boundText(..., { maxLines: 500, unit: "entries" })`.

### bash (`src/tools/bash.ts`) — Wave 1

- One shared `BoundedBuffer` (maxChars 50_000, headChars 10_000); stdout and stderr readers
  `push()` chunks as they arrive (also interleaves streams closer to real time — note in PR).
- Real streaming: `onUpdate(buffer.snapshot())` inside the read loop, throttled ≥250ms,
  existing try/catch retained. Fix the header comment. (UI consumption of updates is a
  separate loop change, out of P0 — `loop.ts:448-451` buffers updates until completion.)
- Completion: `finish()`; body + `[exit <code>]`; details `{ exit_code, ...boundDetails(b) }`.
- Timeout/abort include partial output:
  `` `bash: timed out after ${ms} ms\n--- partial output ---\n${buffer.snapshot()}` `` —
  prefix preserved so existing matchers (anti-spiral, bash-group tests) keep working; verify
  `bash-group.test.ts` regexes are prefix-tolerant when implementing.
- Cheap async-ification of the workdir `existsSync`/`statSync` checks (messages unchanged).

### apply_patch (`src/tools/apply_patch.ts`) — Wave 1

Worth doing, mechanical: keep `parsePatch`/`planPatch`/`applyHunks` pure+sync
(`permissions.ts:140` depends on sync `parsePatch`); move IO to the edges — pre-read all
referenced files with `await readFile` into a Map, pass a map-backed sync reader into
`planPatch` (signature unchanged); `writePlan` goes async (fs/promises); `diskReader` deleted.
Existing `apply_patch.test.ts` suite is the regression net; no assertions change.

## Test matrix

New files `tests/bounds.test.ts`, `tests/grep.test.ts`, `tests/tool-schemas.test.ts` (all
Wave 0), `tests/glob.test.ts` (Wave 1); extensions to `tests/tools.test.ts` (read/ls/bash).
All hermetic (mkdtemp + rm, no network, no LLM).
Engine-dependent tests: `test.if(Bun.which("rg") !== null)` + the `rgCmd:null` seam so both
paths run on any machine. **RED = fails against current code** (the regression guarantee).

| # | Test | Scenario | Assertion |
|---|---|---|---|
| B1 | bounds: head cap by lines | 500 lines, maxLines 200 | 200-line body; notice `[output truncated: showing first 200 of 500 lines]` (new) |
| B2 | bounds: char cap at line boundary | 10×10k-char lines, maxChars 50k | body ≤50k, ends on a full line (new) |
| B3 | bounds: headTail keeps both ends | 200k chars | head+tail content survive; `[... N chars omitted ...]`; notice null (new) |
| B4 | bounds: under cap untouched | small input | body identical; truncated false; notice null (new) |
| B5 | bounds: BoundedBuffer streaming | 1MB pushed in 1k chunks | snapshot ≤ cap+marker; totalChars=1MB; head prefix + tail suffix intact (new) |
| B6 | bounds: lower-bound total | totalIsLowerBound | notice shows `of 10000+ matches` (new) |
| B7 | bounds: both caps compose | 300 lines where line 150 is 60k chars, maxLines 200 + maxChars 50k | whole lines until either cap; oversized line hard-cut counts as one shown line; notice reports shown/total (new — pins the cap-interaction spec) |
| T1 | tool-schemas snapshot pin | `builtinTools()` jsonSchemas vs checked-in snapshot | any non-additive change fails loudly; Wave 1's `include_ignored` = deliberate snapshot update (new — `tests/tool-schemas.test.ts`, Wave 0) |
| G1 | grep: rg path emits file:line:content | match on line 3 (`test.if(rg)`) | `/f\.txt:3:alpha/` — **RED (the -n/-N bug)** |
| G2 | grep: buildRgArgs unit | pure call | has `-n` + `--sort path`; NOT `-N` — **RED** |
| G3 | grep: fallback emits line numbers | `rgCmd:null` | `/:3:/` (green; guards rewrite) |
| G4 | grep: fallback excludes node_modules/.git | match only under node_modules; `rgCmd:null` | absent — **RED** |
| G5 | grep: cap + standardized notice | 300 matches | 200 shown; new notice; `details.count===300`, truncated — **RED** |
| G6 | grep: long match line truncated | 10k-char line | ≤ ~2000 + `…(truncated)` — **RED** |
| G7 | grep: bad regex clean error | pattern `[`, both paths | `/grep error/`, no throw (green) |
| G8 | grep: partial results on exit 2 | chmod-000 subdir + readable match (`test.if(uid!==0)`) | matches + `[note: some paths could not be searched]` — **RED** |
| G9 | grep: case_insensitive both paths | `AlPhA` vs `alpha` | found (green) |
| L1 | glob: sorted before cap + notice | 250 files created out of order | first-200-in-sort-order; notice `showing first 200 of 250 matches` — **RED** |
| L2 | glob: gitignore filtering (rg path) | tree with `.git/`, `.gitignore` "dist/", node_modules/, keep.txt | only keep.txt — **RED** |
| L3 | glob: fallback excludes node_modules | same tree, `rgCmd:null` | node_modules absent; dist/ PRESENT (documented asymmetry) — **RED** |
| L4 | glob: include_ignored=true | same tree | node_modules + dotfiles present (new param) |
| L5 | glob: `*.ts` stays top-level on rg path | a.ts + sub/b.ts, both engines | only `a.ts` — guards Bun.Glob.match choice (new) |
| L6 | glob: zero-match hint on rg path | no matches | contains `include_ignored` hint (new) |
| R1 | read: binary guard | file with 0x00 bytes | `/read: binary file/` — **RED** |
| R2 | read: image extension guard | empty `x.png` | `/image file not supported/` — **RED** |
| R3 | read: huge single line bounded | 100k-char one-line file | line ≤ ~2010 + `…(truncated)` (green; guards streaming rewrite) |
| R4 | read: deep offset window exact | 10k lines, offset 9000 limit 5 | exact `9000:`–`9004:` numbering + `…(996 more lines…)` trailer, byte-compatible (guards rewrite) |
| R5 | read: total char cap | 2000×300-char lines | ≤ ~200k + cap notice — **RED** |
| S1 | ls: dangling symlink resilience | `symlinkSync("/nowhere", broken)` | listing succeeds; `broken` listed — **RED** |
| S2 | ls: entry cap + notice | 600 files | 500 + `showing first 500 of 600 entries` — **RED** |
| S3 | ls: file path clean error | ls on a regular file | `/ls: not a directory/` — **RED** |
| H1 | bash: output capped head+tail | 5000 printed lines (~60k chars) | body <60k; has `line0` AND `line4999` AND omission marker; `[exit 0]`; details.truncated — **RED** |
| H2 | bash: onUpdate streams mid-run | `echo first; sleep 0.4; echo second` | ≥2 calls; first call has `first` not `second` — **RED** |
| H3 | bash: timeout includes partial output | `echo partial; sleep 5`, timeout 300 | `/timed out/` AND `/partial/` — **RED** |

Existing tests expected untouched: `tools.test.ts` read/ls/bash/roster (formats deliberately
preserved), `apply_patch.test.ts` (internals-only refactor), `bash-group.test.ts` (confirm
prefix-tolerant regexes; adjust only if exact-match).

## Risks / rollbacks

- **glob hiding gitignored paths** is the only fix that REMOVES results a model may have
  relied on (e.g. globbing into `node_modules/lodash/**`). Mitigations: additive
  `include_ignored` param, explicit hint in the zero-match message, updated description.
  Rollback: flip the rg-path default (one conditional), schema untouched.
- **`--sort path`** disables rg parallelism; big trees search slower. Rollback: drop the flag
  (only multi-file output determinism is lost; tests G1/G3 use single-file trees).
- **bash 50k cap** could clip output a flow parses. Verified: plan-verify checks run through
  `src/minima/check.ts`'s own runner (own truncation) — unaffected. Constants live in
  `_bounds.ts` defaults + one call site; rollback = raise the constant.
- **Timeout message suffix + stream interleaving** slightly change model-visible text; the
  prefixes (`bash: timed out after N ms`, `[exit N]`) are preserved for matchers.
- **`details.count` shown→total** for grep/glob: zero consumers in src/ (verified).
- **read binary/image guard** turns silent mojibake into a clean error — strictly better;
  message includes actionable guidance so retry loops self-correct.
- Rollback unit is per-PR: each PR is a self-contained revert with its tests.
