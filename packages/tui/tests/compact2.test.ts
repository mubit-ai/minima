import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message } from "../src/ai/types.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import type { HarnessConfig } from "../src/minima/config.ts";
import type { MinimaAgent } from "../src/minima/runtime.ts";
import { readTool } from "../src/tools/read.ts";
import { ArtifactStore } from "../src/tools/_artifacts.ts";
import type { ToolArtifacts } from "../src/tools/types.ts";
import { compactMessages, maybeAutoCompact } from "../src/tui/compact.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(gcBudget = 0): { db: MinimaDb; store: ArtifactStore; dir: string } {
  const base = tempDir("minima-compact2-");
  const db = new MinimaDb(join(base, "minima.db"));
  const dir = join(base, "artifacts");
  const store = new ArtifactStore({ dir, gcBudgetBytes: gcBudget });
  store.attach(db, "run-cur");
  return { db, store, dir };
}

function msg(
  role: "user" | "assistant" | "toolResult",
  content: string,
  extra: { tool_name?: string; is_error?: boolean } = {},
): Message {
  return new Message({ role, content, ...extra });
}

function fakeAgent(opts: {
  messages: Message[];
  artifacts?: ToolArtifacts | null;
  config?: Partial<HarnessConfig> | undefined;
  contextWindow?: number | null;
}): MinimaAgent {
  const cw = opts.contextWindow ?? null;
  return {
    agentState: { messages: opts.messages, model: cw === null ? null : { context_window: cw } },
    config: opts.config,
    artifacts: opts.artifacts ?? null,
  } as unknown as MinimaAgent;
}

/** In-test parser for the `bytes=B` framing: recovers each pruned message's body by exact
 * byte count off the raw file — never delimiter-scanning — so a header-lookalike body,
 * a missing trailing newline, multi-byte unicode, and empty bodies all round-trip. */
function parseArtifact(
  raw: Buffer,
): { role: string; tool?: string; error: boolean; text: string }[] {
  let pos = 0;
  const readLine = (): string => {
    const nl = raw.indexOf(0x0a, pos);
    const end = nl === -1 ? raw.length : nl;
    const line = raw.subarray(pos, end).toString("utf8");
    pos = end + 1;
    return line;
  };
  const header = readLine();
  const hm = header.match(/^compact\/v1 messages=(\d+)$/);
  if (!hm) throw new Error(`bad header: ${header}`);
  const count = Number(hm[1]);
  const out: { role: string; tool?: string; error: boolean; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    const delim = readLine();
    const dm = delim.match(
      /^--- msg (\d+) role=(\S+)(?: tool=(\S+))?( error)? bytes=(\d+) ---$/,
    );
    if (!dm) throw new Error(`bad delimiter: ${delim}`);
    const bytes = Number(dm[5]);
    const text = raw.subarray(pos, pos + bytes).toString("utf8");
    pos += bytes + 1; // body + the single separator newline
    out.push({ role: dm[2]!, tool: dm[3], error: !!dm[4], text });
  }
  return out;
}

function refFromSummary(summary: string): string | null {
  const m = summary.match(/full transcript at (.+?); read it/);
  return m ? m[1] : null;
}

/** Independent reproduction of the legacy 200/200/100 gist parts (byte-identity oracle). */
function legacyParts(allMessages: Message[]): string[] {
  const old = allMessages.slice(0, allMessages.length - 6);
  const parts: string[] = [];
  for (const m of old) {
    if (m.role === "user") parts.push(`User: ${m.textContent.slice(0, 200)}`);
    else if (m.role === "assistant") parts.push(`Assistant: ${m.textContent.slice(0, 200)}`);
    else if (m.role === "toolResult")
      parts.push(`Tool(${m.tool_name}): ${m.textContent.slice(0, 100)}`);
  }
  return parts;
}

// Six varied pruned messages exercising every serialization edge case, plus six recent
// messages that stay in the window (12 total → oldMessages = first 6).
function edgeCaseMessages(): { old: Message[]; all: Message[] } {
  const old = [
    msg("user", "hello world"),
    msg("assistant", "line1\nline2\n"), // trailing newline
    msg("toolResult", "--- msg 0 role=user bytes=999 ---", { tool_name: "bash" }), // delimiter lookalike
    msg("user", "café ☕ 日本語 — multibyte"), // unicode
    msg("assistant", "", { is_error: true }), // empty + error flag
    msg("toolResult", "no newline at end", { tool_name: "grep" }),
  ];
  const recent = Array.from({ length: 6 }, (_, i) => msg("user", `recent ${i}`));
  return { old, all: [...old, ...recent] };
}

describe("compact2 — losslessness (AC1)", () => {
  test("the summary path exists and parsing recovers every pruned message verbatim", () => {
    const { store } = fixture();
    const { old, all } = edgeCaseMessages();
    const agent = fakeAgent({ messages: all, artifacts: store, config: { compact2: true } });

    const out = compactMessages(agent, all);
    const summary = out[0]!.textContent;
    const ref = refFromSummary(summary);
    expect(ref).not.toBeNull();
    expect(existsSync(ref!)).toBe(true);

    const parsed = parseArtifact(readFileSync(ref!));
    expect(parsed).toHaveLength(old.length);
    for (let i = 0; i < old.length; i++) {
      expect(parsed[i]!.text).toBe(old[i]!.textContent);
    }
    // Metadata round-trips too.
    expect(parsed[2]!.role).toBe("toolResult");
    expect(parsed[2]!.tool).toBe("bash");
    expect(parsed[4]!.error).toBe(true);
    // Recent window is preserved unchanged after the summary.
    expect(out.slice(1)).toEqual(all.slice(-6));
  });
});

describe("compact2 — flag-off byte-identity (AC2)", () => {
  test("artifacts null → exact legacy output, dir stays empty", () => {
    const { dir } = fixture();
    const { all } = edgeCaseMessages();
    const off = compactMessages(fakeAgent({ messages: all, artifacts: null }), all);
    expect(off[0]!.textContent).toBe(`[Compacted 6 messages]\n${legacyParts(all).join("\n")}`);
    expect(off[0]!.textContent).toContain("[Compacted 6 messages]");
    expect(off[0]!.textContent).not.toContain("full transcript at");
    // The store's dir is only ever created on first spill; nothing spilled → still absent.
    expect(existsSync(dir)).toBe(false);
    expect(off.slice(1)).toEqual(all.slice(-6));
  });
});

describe("compact2 — own-flag off (AC3)", () => {
  test("config.compact2 false with a live store → byte-identical legacy, no file", () => {
    const { store, dir } = fixture();
    const { all } = edgeCaseMessages();
    const legacy = compactMessages(fakeAgent({ messages: all, artifacts: null }), all);
    const off = compactMessages(
      fakeAgent({ messages: all, artifacts: store, config: { compact2: false } }),
      all,
    );
    expect(off[0]!.textContent).toBe(legacy[0]!.textContent);
    expect(off[0]!.textContent).not.toContain("full transcript at");
    expect(existsSync(dir)).toBe(false);
  });

  test("fail-open store whose sink returns null → legacy output", () => {
    const { all } = edgeCaseMessages();
    const legacy = compactMessages(fakeAgent({ messages: all, artifacts: null }), all);
    const nullStore: ToolArtifacts = {
      dir: "/nowhere",
      sink: () => () => null,
      beginStream: () => null,
    };
    const out = compactMessages(
      fakeAgent({ messages: all, artifacts: nullStore, config: { compact2: true } }),
      all,
    );
    expect(out[0]!.textContent).toBe(legacy[0]!.textContent);
    expect(out[0]!.textContent).not.toContain("full transcript at");
  });
});

describe("compact2 — GC run_id-exemption inheritance (AC4)", () => {
  test("compaction artifact survives GC at a budget below its size; old-run rows evicted", () => {
    // Budget far below the compaction artifact so GC MUST want to evict something.
    const { db, store, dir } = fixture(200);
    // Seed over-budget rows owned by a DIFFERENT (old) run.
    const seed = (content: string, epoch: number) => {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(content);
      const sha = hasher.digest("hex");
      const path = join(dir, `${sha}.txt`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, content, "utf8");
      db.recordArtifact({
        sha,
        path,
        runId: "run-old",
        toolName: "grep",
        bytes: Buffer.byteLength(content, "utf8"),
        lineCount: 1,
      });
      db.db.run("UPDATE artifacts SET created = ?, last_used = ?, run_id = 'run-old' WHERE sha = ?", [
        epoch,
        epoch,
        sha,
      ]);
      return { sha, path };
    };
    const oldA = seed("a".repeat(300), 100);
    const oldB = seed("b".repeat(300), 200);

    const { all } = edgeCaseMessages();
    const agent = fakeAgent({ messages: all, artifacts: store, config: { compact2: true } });
    const out = compactMessages(agent, all);
    const ref = refFromSummary(out[0]!.textContent);
    expect(ref).not.toBeNull();

    // Old-run rows + files evicted by GC.
    expect(existsSync(oldA.path)).toBe(false);
    expect(existsSync(oldB.path)).toBe(false);
    const oldRow = (sha: string) =>
      db.db.query("SELECT sha FROM artifacts WHERE sha = ?").get(sha);
    expect(oldRow(oldA.sha)).toBeNull();
    expect(oldRow(oldB.sha)).toBeNull();

    // Compaction artifact file + row survive with the CURRENT run id, even over budget.
    expect(existsSync(ref!)).toBe(true);
    const compactSha = ref!.match(/([0-9a-f]{64})\.txt$/)![1]!;
    const row = db.db
      .query("SELECT run_id, tool_name FROM artifacts WHERE sha = ?")
      .get(compactSha) as { run_id: string; tool_name: string } | null;
    expect(row).not.toBeNull();
    expect(row!.run_id).toBe("run-cur");
    expect(row!.tool_name).toBe("compact");
    db.close();
  });
});

describe("compact2 — recovery via the existing read tool (AC5)", () => {
  test("read reaches the artifact path from an unrelated workdir and pages by offset/limit", async () => {
    const { store } = fixture();
    const { all } = edgeCaseMessages();
    const agent = fakeAgent({ messages: all, artifacts: store, config: { compact2: true } });
    const ref = refFromSummary(compactMessages(agent, all)[0]!.textContent);
    expect(ref).not.toBeNull();

    const unrelated = tempDir("minima-compact2-wd-");
    const tool = readTool({ workdir: unrelated, artifacts: store });
    const head = await tool.execute("t1", { path: ref!, offset: 1, limit: 1 });
    const headText = head.content.map((b) => ("text" in b ? b.text : "")).join("");
    expect(headText).toContain("compact/v1 messages=6");

    const more = await tool.execute("t2", { path: ref!, offset: 1, limit: 200 });
    const moreText = more.content.map((b) => ("text" in b ? b.text : "")).join("");
    expect(moreText).toContain("café ☕ 日本語 — multibyte");
  });
});

describe("compact2 — auto-compaction path (AC6)", () => {
  test("maybeAutoCompact over 80% spills and the new summary carries the path", () => {
    const { store } = fixture();
    // 12 large messages so estimated tokens exceed 80% of a small context window.
    const big = Array.from({ length: 12 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `turn ${i} ${"x".repeat(435)}`),
    );
    const agent = fakeAgent({
      messages: big,
      artifacts: store,
      config: { compact2: true },
      contextWindow: 1000,
    });
    expect(maybeAutoCompact(agent)).toBe(true);
    expect(agent.agentState.messages).toHaveLength(7);
    const summary = agent.agentState.messages[0]!.textContent;
    const ref = refFromSummary(summary);
    expect(ref).not.toBeNull();
    expect(existsSync(ref!)).toBe(true);
  });
});
