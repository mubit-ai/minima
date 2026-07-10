import { describe, expect, test } from "bun:test";
import type { FileChangeRow } from "../src/db/minima_db.ts";
import {
  type FactorFs,
  classifyCheckOrigin,
  computeCoverageHit,
  detectTamper,
  hasSkipMarker,
  isTestPath,
  parseTestPathsFromVerify,
  pathsMatch,
} from "../src/minima/gt_factors.ts";

// Stage 5 factor computation (M5.1 provenance, M5.2 coverage, M5.3 tamper). Pure functions —
// filesystem access is injected, so these run with no real disk.

/** A minimal file_changes row (only the fields the factor code reads). */
function fc(path: string, kind: FileChangeRow["kind"] = "modified"): FileChangeRow {
  return { id: "x", plan_id: "p", step_id: null, path, kind, origin: null, created_at: null };
}

/** An in-memory FactorFs backed by a path→contents map (absent key = missing file). */
function memFs(files: Record<string, string>): FactorFs {
  return {
    read: (p) => (p in files ? files[p]! : null),
    exists: (p) => p in files,
  };
}

// --------------------------------------------------------------------------- path helpers

describe("isTestPath", () => {
  test("recognizes JS/TS and pytest conventions and tests/ dirs", () => {
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.spec.tsx")).toBe(true);
    expect(isTestPath("tests/auth/test_login.py")).toBe(true);
    expect(isTestPath("pkg/login_test.py")).toBe(true);
    expect(isTestPath("tests/anything.py")).toBe(true);
    expect(isTestPath("__tests__/x.js")).toBe(true);
  });
  test("rejects ordinary source files", () => {
    expect(isTestPath("src/foo.ts")).toBe(false);
    expect(isTestPath("src/login.py")).toBe(false);
    expect(isTestPath("")).toBe(false);
    expect(isTestPath("latest.ts")).toBe(false); // "test" substring but not a test file
  });
});

describe("pathsMatch", () => {
  test("equal and path-suffix matches, never bare-basename collisions", () => {
    expect(pathsMatch("src/foo.test.ts", "src/foo.test.ts")).toBe(true);
    expect(pathsMatch("packages/tui/src/foo.test.ts", "src/foo.test.ts")).toBe(true);
    expect(pathsMatch("./src/foo.test.ts", "src/foo.test.ts")).toBe(true);
    expect(pathsMatch("a/foo.ts", "b/foo.ts")).toBe(false); // same basename, different dir
    expect(pathsMatch("notfoo.ts", "foo.ts")).toBe(false); // suffix, but not a segment boundary
  });
});

describe("parseTestPathsFromVerify", () => {
  test("extracts the test file, stripping pytest node ids and flags", () => {
    expect(parseTestPathsFromVerify("pytest tests/auth/test_login.py::test_redirect")).toEqual([
      "tests/auth/test_login.py",
    ]);
    expect(parseTestPathsFromVerify("bun test src/foo.test.ts")).toEqual(["src/foo.test.ts"]);
    expect(parseTestPathsFromVerify('cd pkg && pytest -q "tests/test_x.py"')).toEqual([
      "tests/test_x.py",
    ]);
  });
  test("returns [] for project-level checks that name no test file", () => {
    expect(parseTestPathsFromVerify("bun run check")).toEqual([]);
    expect(parseTestPathsFromVerify("tsc --noEmit")).toEqual([]);
    expect(parseTestPathsFromVerify("make test")).toEqual([]);
    expect(parseTestPathsFromVerify("true")).toEqual([]);
    expect(parseTestPathsFromVerify("")).toEqual([]);
    expect(parseTestPathsFromVerify(null)).toEqual([]);
  });
  test("strips trailing shell punctuation from chained / subshell verify commands", () => {
    expect(parseTestPathsFromVerify("pytest tests/x_test.py; echo ok")).toEqual([
      "tests/x_test.py",
    ]);
    expect(parseTestPathsFromVerify("(cd pkg && pytest tests/x_test.py)")).toEqual([
      "tests/x_test.py",
    ]);
    expect(parseTestPathsFromVerify("bun test src/a.test.ts && bun test src/b.test.ts")).toEqual([
      "src/a.test.ts",
      "src/b.test.ts",
    ]);
  });
});

// --------------------------------------------------------------------------- M5.1 provenance

describe("classifyCheckOrigin (M5.1)", () => {
  test("agent_new when the verify's test file was created/modified this run", () => {
    const changes = [fc("src/foo.ts", "modified"), fc("src/foo.test.ts", "created")];
    expect(classifyCheckOrigin("bun test src/foo.test.ts", changes)).toBe("agent_new");
  });
  test("pre_existing when the test file was NOT touched this run", () => {
    const changes = [fc("src/foo.ts", "modified")];
    expect(classifyCheckOrigin("bun test src/foo.test.ts", changes)).toBe("pre_existing");
  });
  test("pre_existing for a project-level check with no test-file argument", () => {
    const changes = [fc("src/foo.ts", "modified"), fc("src/foo.test.ts", "created")];
    expect(classifyCheckOrigin("bun run check", changes)).toBe("pre_existing");
  });
  test("matches across a path prefix (agent wrote src/, verify names it plainly)", () => {
    const changes = [fc("packages/tui/tests/test_x.py", "created")];
    expect(classifyCheckOrigin("pytest tests/test_x.py::test_it", changes)).toBe("agent_new");
  });
});

// --------------------------------------------------------------------------- M5.2 coverage

describe("computeCoverageHit (M5.2)", () => {
  test("true when the test references the changed source module", () => {
    const changes = [fc("src/login.ts", "modified"), fc("src/login.test.ts", "created")];
    const fs = memFs({ "src/login.test.ts": 'import { login } from "./login";\ntest("x", …)' });
    expect(computeCoverageHit("bun test src/login.test.ts", changes, fs)).toBe(true);
  });
  test("true via a path-stem reference", () => {
    const changes = [fc("src/api/user.ts", "modified"), fc("t/user.test.ts", "created")];
    const fs = memFs({ "t/user.test.ts": 'import x from "../src/api/user.ts";' });
    expect(computeCoverageHit("bun test t/user.test.ts", changes, fs)).toBe(true);
  });
  test("false when the test is readable but references no changed source", () => {
    const changes = [fc("src/login.ts", "modified"), fc("src/login.test.ts", "created")];
    const fs = memFs({ "src/login.test.ts": 'import { other } from "./other";' });
    expect(computeCoverageHit("bun test src/login.test.ts", changes, fs)).toBe(false);
  });
  test("unknown when no source file changed", () => {
    const changes = [fc("src/login.test.ts", "created")];
    const fs = memFs({ "src/login.test.ts": "whatever" });
    expect(computeCoverageHit("bun test src/login.test.ts", changes, fs)).toBe("unknown");
  });
  test("unknown when the test file cannot be read", () => {
    const changes = [fc("src/login.ts", "modified")];
    expect(computeCoverageHit("bun test src/login.test.ts", changes, memFs({}))).toBe("unknown");
  });
  test("false: a common-word stem (index) appearing as an unrelated identifier is NOT coverage", () => {
    const changes = [fc("src/index.ts", "modified"), fc("src/foo.test.ts", "created")];
    const fs = memFs({ "src/foo.test.ts": "let index = 0;\nexpect(index).toBe(0);" });
    expect(computeCoverageHit("bun test src/foo.test.ts", changes, fs)).toBe(false);
  });
  test("false: a stem-path that is only a prefix of a longer sibling import is NOT coverage", () => {
    const changes = [fc("src/db.ts", "modified"), fc("src/db.test.ts", "created")];
    const fs = memFs({ "src/db.test.ts": 'import x from "../src/dbmigrate";' });
    expect(computeCoverageHit("bun test src/db.test.ts", changes, fs)).toBe(false);
  });
  test("false: a 1-char root-level source stem does not spuriously match everything", () => {
    const changes = [fc("e.ts", "modified"), fc("src/foo.test.ts", "created")];
    const fs = memFs({ "src/foo.test.ts": 'import { thing } from "./thing";' });
    expect(computeCoverageHit("bun test src/foo.test.ts", changes, fs)).toBe(false);
  });
});

// --------------------------------------------------------------------------- M5.3 tamper

describe("hasSkipMarker (M5.3)", () => {
  test("flags pytest / unittest / JS disablers", () => {
    expect(hasSkipMarker("@pytest.mark.skip\ndef test_x(): ...")).toBe(true);
    expect(hasSkipMarker("@pytest.mark.xfail(reason='x')")).toBe(true);
    expect(hasSkipMarker("raise SkipTest")).toBe(true);
    expect(hasSkipMarker("@unittest.skip('later')")).toBe(true);
    expect(hasSkipMarker("test.skip('later', () => {})")).toBe(true);
    expect(hasSkipMarker("describe.skip('x', () => {})")).toBe(true);
    expect(hasSkipMarker("xit('later', () => {})")).toBe(true);
  });
  test("flags module-level pytestmark that disables a whole pytest module", () => {
    expect(hasSkipMarker('pytestmark = pytest.mark.skip(reason="flaky")')).toBe(true);
    expect(hasSkipMarker("pytestmark = [pytest.mark.xfail]")).toBe(true);
  });
  test("conservative: does NOT flag .only, skipif, or ordinary tests", () => {
    expect(hasSkipMarker("test.only('focus', () => {})")).toBe(false);
    expect(hasSkipMarker('@pytest.mark.skipif(sys.platform == "win32", reason="x")')).toBe(false);
    expect(hasSkipMarker('test("passes", () => expect(1).toBe(1))')).toBe(false);
  });
  test("no false positive: a marker inside a comment, docstring, or string literal", () => {
    expect(hasSkipMarker("// do not use it.skip( here\nit('x', () => {})")).toBe(false);
    expect(hasSkipMarker('"""\npytest.skip("example in a docstring")\n"""\ndef test_x(): ...')).toBe(
      false,
    );
    expect(hasSkipMarker('const doc = "call it.skip( to disable";')).toBe(false);
    expect(hasSkipMarker("query { field @skip(if: $hide) }")).toBe(false);
  });
});

describe("detectTamper (M5.3)", () => {
  test("deleted test file → tamper", () => {
    expect(detectTamper([fc("tests/test_a.py", "deleted")], memFs({}))).toBe(true);
  });
  test("test recorded as changed but now absent from disk → tamper", () => {
    // 'created'/'modified' but exists() is false → treated as a deletion.
    expect(detectTamper([fc("tests/test_a.py", "modified")], memFs({}))).toBe(true);
  });
  test("modified test file that now carries a skip marker → tamper", () => {
    const fs = memFs({ "src/a.test.ts": "it.skip('x', () => {})" });
    expect(detectTamper([fc("src/a.test.ts", "modified")], fs)).toBe(true);
  });
  test("brand-new (created) test file born fully skipped → tamper", () => {
    // A Write yields kind='created'; the most realistic fake-test vector must be caught too.
    const fs = memFs({ "src/a.test.ts": "describe.skip('all', () => { it('x', () => {}) })" });
    expect(detectTamper([fc("src/a.test.ts", "created")], fs)).toBe(true);
  });
  test("healthy test edit → no tamper", () => {
    const fs = memFs({ "src/a.test.ts": "it('x', () => expect(1).toBe(1))" });
    expect(detectTamper([fc("src/a.test.ts", "modified")], fs)).toBe(false);
  });
  test("ignores non-test files entirely (a deleted source file is not tamper)", () => {
    expect(detectTamper([fc("src/a.ts", "deleted")], memFs({}))).toBe(false);
  });
});
