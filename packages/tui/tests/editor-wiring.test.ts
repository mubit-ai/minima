import { describe, expect, test } from "bun:test";

import { readSource } from "./_source.ts";

// A LAST RESORT (see _source.ts:1-19), for the app.tsx wiring that bun test cannot exercise:
// Ink's global useInput handler and the composer render. Everything with real logic behind it
// lives in editor.ts / editor_chord.ts and is tested by behavior in the sibling files.

const app = readSource("tui/app.tsx");
const textInput = readSource("tui/text-input.tsx");

describe("app.tsx — the Ctrl+E collision", () => {
  test("the chord latch is read as the FIRST statement of the global handler", () => {
    // Order matters and toContain cannot express it: read below an early return and a busy
    // dispatch leaves justConsumed set, poisoning the NEXT Ctrl+E.
    const handlerAt = app.indexOf("const editorChordKey = chordOwnsKey();");
    expect(handlerAt).toBeGreaterThan(-1);
    // Prefix, not the whole statement: what this asserts is ORDER, and suspendToShell's
    // arguments are not part of that (the fullscreen renderer passes it the renderer state).
    const ctrlZAt = app.indexOf('if (key.ctrl && input === "z") { suspendToShell(');
    expect(ctrlZAt).toBeGreaterThan(-1);
    expect(handlerAt).toBeLessThan(ctrlZAt);
  });

  test("the guard appears BEFORE every action it suppresses", () => {
    // Since the keymap file, the suppression is general: the sequence's second key belongs to
    // the composer whatever it is bound to (it was a thinking-only guard while Ctrl+E was the
    // only key that could BE the second one). So it has to sit above all of them.
    const guardAt = app.indexOf("const editorChordKey = chordOwnsKey();");
    const suppressAt = app.indexOf(
      "if (editorChordKey && matchesSecondChord(input, key)) return;",
    );
    const firstActionAt = app.indexOf('if (action === "permission.cycle")');
    expect(guardAt).toBeGreaterThan(-1);
    expect(suppressAt).toBeGreaterThan(-1);
    expect(firstActionAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(suppressAt);
    expect(suppressAt).toBeLessThan(firstActionAt);
  });

  test("Ctrl+E still returns unconditionally, so it never falls through to another binding", () => {
    // Which key means thinking.cycle lives in keymap.ts; whether the composer already owns
    // this dispatch is decided by the guard above. What survives here is the shape the latch
    // depends on — resolved once, returned unconditionally.
    expect(app).toContain('if (action === "thinking.cycle") { cycleThinkingLevel(); return; }');
  });

  test("chordOwnsKey is CALLED exactly once — it is a one-shot latch", () => {
    expect(app.split("= chordOwnsKey();").length - 1).toBe(1);
  });

  test("Ctrl+G is untouched — it stays Plan Overview, never the editor", () => {
    expect(app).toContain("requestPlanOverview()");
    expect(app).not.toContain('input === "g" && openEditor');
  });
});

describe("app.tsx — applyComposerText moves prefill AND typedText together", () => {
  test("the pair is one helper, so a refactor cannot drop the typedText half", () => {
    expect(app).toContain(
      "function applyComposerText(text: string) { setPrefill({ text, nonce: Date.now() }); setTypedText(text); }",
    );
  });

  test("the editor result is applied through the helper, never through a bare setPrefill", () => {
    expect(app).toContain(
      "if (outcome.apply && outcome.text !== null) applyComposerText(outcome.text);",
    );
    expect(app).not.toContain("setPrefill({ text: outcome.text");
  });

  test("EVERY text seed goes through the helper — there is exactly one setPrefill({ ... })", () => {
    // setPrefill(null) at turn start is a clear, not a seed, so it is excluded by the shape.
    // This is the assertion that stops a future refactor re-splitting the pair at a new site.
    expect(app.split("setPrefill({").length - 1).toBe(1);
  });

  test("/undo and /rewind re-prompt through the helper too", () => {
    expect(app.split("applyComposerText(undonePrompt);").length - 1).toBe(2);
  });
});

describe("app.tsx — openEditor", () => {
  test("it checks the config flag, not process.env", () => {
    expect(app).toContain("if (agent.config.externalEditor !== true)");
    expect(app).not.toContain("process.env.MINIMA_TUI_EDITOR");
  });

  test("it defers out of the keypress dispatch and re-checks busy after the defer", () => {
    expect(app).toContain("if (busy) return; setChordArmed(false); resetChord(); setTimeout(");
    expect(app).toContain("if (busyRef.current) return;");
  });

  test("the post-editor repaint is the reseat + <Static> remount, not a bare state bump", () => {
    // Ink skips the write when the frame is byte-identical and throttles ~32ms; after a
    // full-screen editor the screen is destroyed, so the remount is what forces a paint.
    expect(app).toContain(
      "reseatFreshScreen(); setTranscriptGen((g) => g + 1); setMessages((m) => [...m, { role: \"tool\", text: outcome.notice, toolName: \"editor\" }]);",
    );
  });

  test("text is applied only when the outcome says apply", () => {
    expect(app).toContain(
      "if (outcome.apply && outcome.text !== null) applyComposerText(outcome.text);",
    );
  });

  test("the run id is threaded so the temp file is namespaced per run", () => {
    expect(app).toContain("openEditorForDraft(seed, { runId: agent.runId })");
  });
});

describe("app.tsx — the composer wiring", () => {
  test("onEditorRequest is undefined when the flag is off — the kill switch at this layer", () => {
    expect(app).toContain(
      "onEditorRequest={agent.config.externalEditor === true ? openEditor : undefined}",
    );
  });

  test("onChordArmed drives the armed state", () => {
    expect(app).toContain("onChordArmed={setChordArmed}");
  });

  test("the indicator rides the absolutely-positioned TITLE, adding no rows", () => {
    // Pinned on the FRAGMENT rather than the whole ternary: the title now also carries the
    // attachment count (`· 2 images`), so a whole-expression pin would break on every future
    // title addition while proving nothing more than this does.
    // The chord itself is now spelled from the effective keymap (armedPrefixHint keeps `^X`
    // for a plain Ctrl prefix, which is every default); the fragment is still what is pinned.
    expect(app).toContain("chordArmed ? ` prompt · ${armedPrefixHint()}`");
    // The height reserve is still computed from typedText alone.
    expect(app).toContain("height={2 + inputRows}");
  });
});

describe("app.tsx — /editor", () => {
  test("the command is registered and described", () => {
    expect(app).toContain('name: "editor"');
    expect(app).toContain("Compose in $EDITOR");
  });

  test("it passes its args as the seed (it cannot carry the live draft)", () => {
    expect(app).toContain('case "editor": openEditor(args.trim());');
  });

  test("the chord is in the keyboard help", () => {
    // Printed from the EFFECTIVE keymap since the keymap file landed, so what the help owes
    // the reader is the lookup, not the literal chord.
    expect(app).toContain('${keyHelp("editor.open")} compose the prompt in $EDITOR');
  });
});

describe("text-input.tsx — the chord feed", () => {
  test("the chord is fed after the disabled/suspended guard and before the draft is read", () => {
    const guardAt = textInput.indexOf("if (disabled || suspended) return;");
    const feedAt = textInput.indexOf("const chord = feedChordKey(input, key);");
    const draftAt = textInput.indexOf("const { value, cursor } = draftRef.current; // key.return");
    expect(guardAt).toBeGreaterThan(-1);
    expect(feedAt).toBeGreaterThan(guardAt);
    expect(draftAt === -1 || feedAt < draftAt).toBe(true);
  });

  test("a cancel FALLS THROUGH so the cancelling key still types", () => {
    expect(textInput).toContain(
      'if (chord.action === "cancel") onChordArmedRef.current?.(false); }',
    );
  });

  test("losing the keyboard resets the chord, and so does unmounting", () => {
    // Arming then losing the keyboard (a 🔴 gate, an overlay) would otherwise strand
    // `armed` in the singleton, permanently suppressing app-level Ctrl+E.
    expect(textInput).toContain(
      "const chordActive = Boolean(onEditorRequest) && !disabled && !suspended;",
    );
    expect(textInput).toContain(
      "if (!chordActive) { resetChord(); onChordArmedRef.current?.(false); return; } return () => { resetChord(); onChordArmedRef.current?.(false); };",
    );
  });

  test("the launch hands over the CURRENT draft, read from the ref", () => {
    expect(textInput).toContain("onEditorRequest(draftRef.current.value);");
  });
});
