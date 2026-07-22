/**
 * Plan-verification factor computation (Stage 5 — M5.1 provenance, M5.2 coverage, M5.3 tamper).
 *
 * Track A's "check engine" fills three of the {@link Factors} fields that Stage 4 left
 * hardcoded (checkOrigin/coverageHit/tamper). These are the *trust* signals: was the passing
 * check a test the agent wrote this run (grading its own homework), does it actually touch the
 * code the step changed, and did the agent quietly skip/delete a test to make the line go
 * green? Track B's confidence() (M6.1) reads exactly these values.
 *
 * This module is PURE: every function is total (never throws on bad input) and takes its
 * filesystem access through an injected {@link FactorFs} accessor, so the whole engine is
 * unit-testable with no real disk. `defaultFactorFs` is the production accessor (node:fs,
 * resolving relative paths against the check's cwd == process.cwd()); it swallows every error
 * as "not readable"/"does not exist" so a bookkeeping read can never break a turn.
 */
import { existsSync, readFileSync } from "node:fs";
import type { FileChangeRow } from "../db/minima_db.ts";
import type { CheckOrigin } from "./big_plan_contract.ts";

/** Injected filesystem seam — total (never throws); returns null/false on any failure. */
export interface FactorFs {
  /** File contents, or null when the path is missing/unreadable/binary. */
  read(path: string): string | null;
  /** Whether the path currently exists on disk. */
  exists(path: string): boolean;
}

/** Production accessor: node:fs, fail-closed to "unreadable"/"absent" on any error. */
export const defaultFactorFs: FactorFs = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists(path) {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

/** Normalize a path for comparison: forward slashes, drop a leading `./`. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Final path segment (basename). */
function basename(p: string): string {
  return norm(p).split("/").pop() ?? "";
}

/** Strip a single trailing file extension (`foo.test.ts` → `foo.test`, `foo` → `foo`). */
function stripExt(p: string): string {
  return p.replace(/\.[a-z0-9]+$/i, "");
}

/**
 * Two paths refer to the same file when they are equal, or one is a path-segment suffix of the
 * other (so `src/foo.test.ts` written by the agent matches a `packages/tui/src/foo.test.ts`
 * file_change, but `foo.ts` never matches `notfoo.ts`). Basename-only matching is deliberately
 * NOT used — it would collide two same-named tests in different dirs.
 *
 * Known limitation: with a cwd-scoped verify (`cd pkg-a && pytest tests/test_utils.py`) and a
 * duplicate-named file changed in another package (`pkg-b/tests/test_utils.py`), the short
 * suffix still matches — so a pre_existing test can read agent_new. This errs on the SAFE
 * side (extra scrutiny → caps at 🟡, never falsely 🟢) and can't be resolved without the
 * verify's cwd, so it is accepted rather than papered over.
 */
export function pathsMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

/**
 * Does a path look like a test file? Recognizes the common conventions across the ecosystems
 * this harness runs in: `*.test.*` / `*.spec.*` (JS/TS), `test_*.py` / `*_test.py` (pytest),
 * and anything under a `tests/`, `test/`, or `__tests__/` directory.
 */
export function isTestPath(path: string): boolean {
  if (!path) return false;
  const p = norm(path).toLowerCase();
  const base = basename(p);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/^test_.+\.py$/.test(base) || /_test\.py$/.test(base)) return true;
  if (/(^|\/)(tests?|__tests__)\//.test(p)) return true;
  return false;
}

/**
 * Pull the test-file path(s) out of a `verify` command. Tokenizes on whitespace, unquotes,
 * drops flags, strips a pytest `::node_id` selector and any trailing `:line[:col]`, and keeps
 * only tokens that carry a file extension AND look like a test file. Returns [] for a
 * project-level check with no file argument (`bun run check`, `make test`, `tsc --noEmit`).
 */
export function parseTestPathsFromVerify(verify: string | null | undefined): string[] {
  if (!verify) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawTok of verify.split(/\s+/)) {
    // Strip surrounding quotes AND shell punctuation so a path glued to a subshell/chain
    // operator still parses — `(cd x && pytest tests/x_test.py)` → `tests/x_test.py)`,
    // `pytest tests/x.py; echo ok` → `tests/x.py;` — otherwise the trailing ) or ; defeats
    // the extension gate below and an agent-authored test is misread as pre_existing.
    let tok = rawTok
      .trim()
      .replace(/^[('"`]+/, "")
      .replace(/[)'"`;,&|]+$/g, "");
    if (!tok || tok.startsWith("-")) continue; // skip empty and flags
    tok = tok.split("::")[0]!; // pytest node id: tests/x.py::test_y → tests/x.py
    tok = tok.replace(/:\d+(:\d+)?$/, ""); // grep-style trailing :line[:col]
    if (!/\.[a-z0-9]+$/i.test(tok)) continue; // must name a file (has an extension)
    if (!isTestPath(tok)) continue;
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

/** file_changes whose path was created or modified this run (the agent's writes). */
function changedThisRun(changes: readonly FileChangeRow[]): FileChangeRow[] {
  return changes.filter((c) => c.kind === "created" || c.kind === "modified");
}

// ---------------------------------------------------------------------------
// M5.1 — provenance.
// ---------------------------------------------------------------------------

/**
 * M5.1: was the step's check a pre-existing test or one the agent wrote this run?
 *
 *   - Parse the test file(s) named in `verify`. If any was created/modified this run
 *     (matched in `changes`) → `agent_new` — the agent is grading its own homework.
 *   - Otherwise → `pre_existing`. This includes a `verify` that names no test file at all
 *     (a project-level gate like `bun run check`), which the agent did not author this run.
 *
 * `user` (a check attached at approval) is never produced HERE — this function only distinguishes
 * agent_new from pre_existing. A user-origin check is recorded out-of-band as `plan_steps.check_origin`
 * (steps seeded from an approved /plan via `seedPlanFromSteps`); the done-gate prefers that stored
 * origin over this classification, so a user-accepted check is not graded as agent homework.
 */
export function classifyCheckOrigin(
  verify: string | null | undefined,
  changes: readonly FileChangeRow[],
): CheckOrigin {
  const testPaths = parseTestPathsFromVerify(verify);
  if (testPaths.length === 0) return "pre_existing";
  const changed = changedThisRun(changes);
  for (const tp of testPaths) {
    for (const c of changed) {
      if (pathsMatch(c.path, tp)) return "agent_new";
    }
  }
  return "pre_existing";
}

// ---------------------------------------------------------------------------
// M5.2 — coverage touch (static heuristic).
// ---------------------------------------------------------------------------

/**
 * Ultra-common basename stems that surface as ordinary identifiers in almost any test
 * (`let index`, an `app` handle, a `utils` import), so a bare-name match against them is noise,
 * not coverage. Matching one would inflate the (non-gating) coverage signal toward green.
 */
const COMMON_STEMS = new Set([
  "index",
  "main",
  "app",
  "util",
  "utils",
  "config",
  "type",
  "types",
  "test",
  "tests",
  "spec",
  "setup",
  "model",
  "models",
  "client",
  "server",
  "api",
  "db",
  "id",
  "helper",
  "helpers",
  "constant",
  "constants",
  "common",
  "core",
  "base",
  "mod",
  "lib",
]);

/**
 * Does `needle` occur in `hay` bounded by a non-identifier char on each side (a real path/token,
 * not a prefix of a longer one)? So a changed `src/db` matches `../src/db"` but not the sibling
 * import `../src/dbmigrate`.
 */
function includesAtBoundary(hay: string, needle: string): boolean {
  const ident = /[a-z0-9_]/;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 ? hay[i - 1]! : "";
    const after = hay[i + needle.length] ?? "";
    if (!ident.test(before) && !ident.test(after)) return true;
  }
  return false;
}

/**
 * Does `hayLower` (a test file's lowered contents) reference a changed source file? Tries the
 * directory-qualified path stem first (`src/foo` — a precise, boundary-checked match), then
 * falls back to the bare module basename (`foo`) as a whole word. The fallback skips
 * ultra-common stems and anything under 3 chars, which would otherwise match unrelated
 * identifiers and inflate the (non-gating) coverage signal into a false positive.
 */
function referencesSource(hayLower: string, sourcePath: string): boolean {
  const p = norm(sourcePath).toLowerCase();
  const stemPath = stripExt(p); // src/foo → `from "../src/foo"`, `import "src/foo"`
  if (stemPath.length >= 3 && includesAtBoundary(hayLower, stemPath)) return true;
  const stem = stripExt(basename(p)); // foo → `from foo import`, `import { x } from "./foo"`
  if (stem.length < 3 || COMMON_STEMS.has(stem)) return false;
  return new RegExp(`\\b${escapeRegExp(stem)}\\b`).test(hayLower);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * M5.2: a cheap check that the test actually exercises the code the step changed. `true` when
 * a test file named in `verify` imports/references any changed *source* (non-test) file;
 * `false` when we could read a test but found no such reference; `"unknown"` when there is
 * nothing to correlate (no changed source, or no test we could name and read). It's a signal,
 * not a gate — a static grep, upgradeable to real line-coverage later.
 */
export function computeCoverageHit(
  verify: string | null | undefined,
  changes: readonly FileChangeRow[],
  fs: FactorFs,
): boolean | "unknown" {
  const testPaths = parseTestPathsFromVerify(verify);
  const sourceChanges = changedThisRun(changes).filter((c) => !isTestPath(c.path));
  if (testPaths.length === 0 || sourceChanges.length === 0) return "unknown";
  let readAny = false;
  for (const tp of testPaths) {
    const content = fs.read(tp);
    if (content === null) continue;
    readAny = true;
    const hay = content.toLowerCase();
    for (const sc of sourceChanges) {
      if (referencesSource(hay, sc.path)) return true;
    }
  }
  return readAny ? false : "unknown";
}

// ---------------------------------------------------------------------------
// M5.3 — tamper.
// ---------------------------------------------------------------------------

/**
 * A test disabler at STATEMENT position — the marker must be the first token of its
 * (comment-stripped) line. Anchoring this way is what keeps a 🔴-forcing signal precise: a
 * marker mentioned inside a string literal, an expression, a trailing comment, or a GraphQL
 * `@skip` directive is NOT tamper; only an actual `@pytest.mark.skip`, `it.skip(...)`, or a
 * module-level `pytestmark = pytest.mark.skip(...)` (which disables a whole pytest module) is.
 *
 * Deliberately EXCLUDED, matching the conservative M5.3 decision: `.only` (a focus-run, not a
 * disable), and `skipif` / `unittest.skipUnless` (a conditional platform guard is legitimate) —
 * the `skip\b`/`skip\s*\(` boundaries ensure `skipif`/`skipped` never trip it.
 */
const LINE_SKIP =
  /^(?:@?pytest\.mark\.(?:skip|xfail)\b|pytestmark\b.*\bpytest\.mark\.(?:skip|xfail)\b|pytest\.skip\s*\(|@?unittest\.skip\s*\(|raise\s+(?:unittest\.)?SkipTest\b|(?:it|test|describe)\.(?:skip|todo)\b|x(?:it|describe)\s*\()/;

/**
 * Strip the comment/docstring forms that could carry a marker on their own line: block
 * comments and Python triple-quoted strings. Single-line `//`/`#` comments need no stripping —
 * a line-start marker anchored by LINE_SKIP already cannot begin with `//` or `#`.
 */
function stripBlockComments(src: string): string {
  return src
    .replace(/'''[\s\S]*?'''/g, "\n")
    .replace(/"""[\s\S]*?"""/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "\n");
}

/**
 * Are there test-disabling markers at statement position in this test file's contents?
 *
 * Limitation: this reads the CURRENT file, not a diff, so a disabler that pre-existed in a file
 * the agent merely touched this step also counts. That over-approximation is intentional — the
 * ledger holds no pre-edit content — and stays on the conservative side of "stop the line".
 */
export function hasSkipMarker(content: string): boolean {
  for (const raw of stripBlockComments(content).split("\n")) {
    if (LINE_SKIP.test(raw.trim())) return true;
  }
  return false;
}

/**
 * M5.3: did the agent weaken the suite this step? `true` when a test file was deleted (recorded
 * as `kind='deleted'`, or recorded as changed but now absent from disk), or when a test file it
 * touched this run now contains a skip/xfail marker. This is the one factor that should always
 * stop the line, so the marker set is kept conservative (see {@link SKIP_MARKER}).
 */
export function detectTamper(changes: readonly FileChangeRow[], fs: FactorFs): boolean {
  for (const c of changes) {
    if (!isTestPath(c.path)) continue;
    if (c.kind === "deleted") return true;
    if (!fs.exists(c.path)) return true; // recorded as changed, gone now → deleted
    if (c.kind === "created" || c.kind === "modified") {
      const content = fs.read(c.path);
      if (content !== null && hasSkipMarker(content)) return true;
    }
  }
  return false;
}
