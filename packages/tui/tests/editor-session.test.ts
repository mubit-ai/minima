import { describe, expect, test } from "bun:test";

import {
  type EditorIo,
  NOTICE,
  runEditorSession,
  openEditorForDraft,
} from "../src/tui/editor.ts";

const ESC = String.fromCharCode(27);

interface Fake {
  io: EditorIo;
  log: string[];
  written: Record<string, string>;
}

function fakeIo(over: Partial<EditorIo> = {}, files: Record<string, string> = {}): Fake {
  const log: string[] = [];
  const written: Record<string, string> = { ...files };
  let clock = 1000;
  const io: EditorIo = {
    stdoutWrite: (s) => {
      log.push(`write:${s.replace(ESC, "ESC")}`);
    },
    detachStdin: () => {
      log.push("detachStdin");
      return () => log.push("reattach");
    },
    pauseStdin: () => {
      log.push("pauseStdin");
    },
    resumeStdin: () => {
      log.push("resumeStdin");
    },
    setRawMode: (on) => {
      log.push(`setRawMode:${on}`);
    },
    resetFilter: () => {
      log.push("resetFilter");
    },
    guardSignals: () => {
      log.push("guardSignals");
      return () => log.push("releaseSignals");
    },
    spawn: (argv) => {
      log.push(`spawn:${argv.join(" ")}`);
      return { exitCode: 0 };
    },
    writeFile: (path, content) => {
      log.push("writeFile");
      written[path] = content;
    },
    chmod600: () => {
      log.push("chmod600");
    },
    readFile: (path) => {
      log.push("readFile");
      const v = written[path];
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    removeFile: (path) => {
      log.push("removeFile");
      delete written[path];
    },
    now: () => {
      clock += 5000;
      return clock;
    },
    isTty: () => true,
    ...over,
  };
  return { io, log, written };
}

const OPTS = { seed: "hello", argv: ["vi"], path: "/tmp/compose.md" };

describe("runEditorSession — the TTY handover", () => {
  test("the happy path teardown/spawn/restore sequence is exact and ordered", () => {
    const f = fakeIo({
      spawn: () => ({ exitCode: 0 }),
    });
    // The editor "saves" different text so the outcome is `apply`.
    f.io.spawn = (argv) => {
      f.log.push(`spawn:${argv.join(" ")}`);
      f.written["/tmp/compose.md"] = "edited body\n";
      return { exitCode: 0 };
    };
    const out = runEditorSession(OPTS, f.io);

    expect(f.log).toEqual([
      "writeFile",
      "chmod600",
      `write:ESC[?2004l`,
      `write:ESC[?25h`,
      "detachStdin",
      "pauseStdin",
      "setRawMode:false",
      "resetFilter",
      "guardSignals",
      "spawn:vi /tmp/compose.md",
      "setRawMode:true",
      "resetFilter",
      "resumeStdin",
      "reattach",
      "releaseSignals",
      `write:ESC[?1049l`,
      `write:ESC[?25l`,
      `write:ESC[?2004h`,
      "readFile",
      "removeFile",
    ]);
    expect(out.apply).toBe(true);
    expect(out.text).toBe("edited body");
  });

  test("detach happens BEFORE pause (pause is a no-op while a readable listener is attached)", () => {
    const f = fakeIo();
    runEditorSession(OPTS, f.io);
    expect(f.log.indexOf("detachStdin")).toBeLessThan(f.log.indexOf("pauseStdin"));
  });

  test("resetFilter runs both before the spawn and again in the restore", () => {
    const f = fakeIo();
    runEditorSession(OPTS, f.io);
    const resets = f.log.reduce<number[]>((acc, v, i) => (v === "resetFilter" ? [...acc, i] : acc), []);
    expect(resets.length).toBe(2);
    const spawnAt = f.log.findIndex((l) => l.startsWith("spawn:"));
    expect(resets[0]!).toBeLessThan(spawnAt);
    expect(resets[1]!).toBeGreaterThan(spawnAt);
  });

  test("the restore is the exact reverse of the teardown", () => {
    const f = fakeIo();
    runEditorSession(OPTS, f.io);
    const at = (s: string) => f.log.indexOf(s);
    // teardown: paste-off, cursor-show, detach, pause, rawmode-off, guard
    expect(at("write:ESC[?2004l")).toBeLessThan(at("write:ESC[?25h"));
    expect(at("write:ESC[?25h")).toBeLessThan(at("detachStdin"));
    expect(at("pauseStdin")).toBeLessThan(at("setRawMode:false"));
    expect(at("setRawMode:false")).toBeLessThan(at("guardSignals"));
    // restore: rawmode-on, resume, reattach, release, alt-off, cursor-hide, paste-on
    expect(at("setRawMode:true")).toBeLessThan(at("resumeStdin"));
    expect(at("resumeStdin")).toBeLessThan(at("reattach"));
    expect(at("reattach")).toBeLessThan(at("releaseSignals"));
    expect(at("releaseSignals")).toBeLessThan(at("write:ESC[?1049l"));
    expect(at("write:ESC[?1049l")).toBeLessThan(at("write:ESC[?25l"));
    expect(at("write:ESC[?25l")).toBeLessThan(at("write:ESC[?2004h"));
  });

  test("a THROWING spawn still runs the whole restore suffix in order, and unlinks", () => {
    const f = fakeIo({
      spawn: () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'nope'"), {
          code: "ENOENT",
        });
      },
    });
    const out = runEditorSession(OPTS, f.io);
    expect(f.log.slice(f.log.indexOf("guardSignals") + 1)).toEqual([
      "setRawMode:true",
      "resetFilter",
      "resumeStdin",
      "reattach",
      "releaseSignals",
      `write:ESC[?1049l`,
      `write:ESC[?25l`,
      `write:ESC[?2004h`,
      "readFile",
      "removeFile",
    ]);
    expect(out.apply).toBe(false);
    expect(out.isError).toBe(true);
    expect(out.notice).toContain("ENOENT");
    expect(f.written["/tmp/compose.md"]).toBeUndefined();
  });

  test("a THROWING readFile still unlinks and keeps the draft", () => {
    const f = fakeIo({
      readFile: () => {
        throw new Error("EACCES");
      },
    });
    const out = runEditorSession(OPTS, f.io);
    expect(f.log).toContain("removeFile");
    expect(out.apply).toBe(false);
    expect(out.isError).toBe(true);
    expect(out.notice).toBe(NOTICE.unreadable);
  });

  test("a THROWING removeFile does not escape (the outcome is still decided)", () => {
    const f = fakeIo({
      removeFile: () => {
        throw new Error("EPERM");
      },
    });
    const out = runEditorSession(OPTS, f.io);
    expect(out.apply).toBe(false);
    expect(out.notice).toBe(NOTICE.noChanges);
  });

  test("isTty() false does NO teardown at all and never spawns", () => {
    const f = fakeIo({ isTty: () => false });
    const out = runEditorSession(OPTS, f.io);
    expect(f.log).toEqual([]);
    expect(out.notice).toBe(NOTICE.notTty);
    expect(out.apply).toBe(false);
    expect(out.isError).toBe(false);
  });

  test("a failing writeFile bails before ANY terminal mutation", () => {
    const f = fakeIo({
      writeFile: () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    const out = runEditorSession(OPTS, f.io);
    expect(f.log).toEqual([]); // no escape write, no detach, no spawn
    expect(out.isError).toBe(true);
    expect(out.notice).toContain("EROFS");
  });

  test("the seed reaches writeFile verbatim, and the path is APPENDED to argv", () => {
    const f = fakeIo();
    const seed = "line one\n\n  indented\ttab\nfinal";
    runEditorSession({ seed, argv: ["code", "--wait"], path: "/tmp/has space.md" }, f.io);
    expect(f.written["/tmp/has space.md"]).toBeUndefined(); // unlinked afterwards
    expect(f.log).toContain("spawn:code --wait /tmp/has space.md");
  });

  test("writeFile receives the seed byte-exact, with no banner", () => {
    const seen: string[] = [];
    const f = fakeIo({
      writeFile: (_p, c) => {
        seen.push(c);
      },
      readFile: () => "x",
    });
    runEditorSession({ ...OPTS, seed: "## not a banner\nbody" }, f.io);
    expect(seen).toEqual(["## not a banner\nbody"]);
  });

  test("chmod 0600 is applied before the terminal is touched", () => {
    const f = fakeIo();
    runEditorSession(OPTS, f.io);
    expect(f.log.indexOf("chmod600")).toBeLessThan(f.log.indexOf(`write:ESC[?2004l`));
  });
});

describe("detachStdin/reattach ordering", () => {
  test("reattach re-adds listeners in their ORIGINAL order", () => {
    const order: string[] = [];
    const a = () => order.push("a");
    const b = () => order.push("b");
    const c = () => order.push("c");
    let attached: (() => void)[] = [a, b, c];
    const f = fakeIo({
      detachStdin: () => {
        const snapshot = attached.slice();
        attached = [];
        return () => {
          attached = snapshot.slice();
        };
      },
    });
    runEditorSession(OPTS, f.io);
    expect(attached).toEqual([a, b, c]);
    for (const fn of attached) fn();
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("openEditorForDraft", () => {
  test("with no editor anywhere it never spawns and says so", () => {
    const f = fakeIo();
    const out = openEditorForDraft("draft", { env: {}, which: () => null }, f.io);
    expect(out.notice).toBe(NOTICE.noEditor);
    expect(out.isError).toBe(true);
    expect(f.log).toEqual([]);
  });

  test("the resolved editor's argv reaches spawn with the temp path appended", () => {
    const f = fakeIo();
    openEditorForDraft(
      "draft",
      { env: { EDITOR: "code --wait" }, which: () => null, tmpDir: "/tmp", runId: "run7" },
      f.io,
    );
    const spawnLine = f.log.find((l) => l.startsWith("spawn:"))!;
    expect(spawnLine.startsWith("spawn:code --wait /tmp/minima-compose-run7-")).toBe(true);
    expect(spawnLine.endsWith(".md")).toBe(true);
  });
});
