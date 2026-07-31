# Tier 1 manual test guide

Manual checks for the four Track A — Tier 1 features (PRs #322–#325), all merged into
`research/new-features-research`. Every one of these is something `bun test` **cannot**
prove: they need a real terminal, a real provider, or a real editor.

Budget ~20 minutes for all four. Each section is self-contained — skip freely.

---

## Setup (once)

```bash
cd /Users/eldaru/Mubit/Minima/new-features-research
git log --oneline -5     # expect c91d266 editor, 506a8f0 ctx, 76cb5bf notify, d58a5a7 image
```

Everything below runs **from source** via your `minima-loc` function, which sources
`.env.harness` (provider keys) and execs `bun run …/packages/tui/src/cli/main.ts`:

```bash
minima-loc --wt new-features-research
```

Env overrides go **in front**, extra args after:

```bash
MINIMA_TUI_NOTIFY=0 minima-loc --wt new-features-research --model claude-haiku-4-5 --provider anthropic
```

Make a test image once — the repo ships none:

```bash
screencapture -x /tmp/minima-test.png && ls -lh /tmp/minima-test.png
```

Pick something with legible text on screen before you run that, so "does the model actually
see it" has an unambiguous answer.

---

## 1 · Image input (#322)

The `read` tool returns the image itself to models that accept image input. Anthropic nests
it in the tool result; OpenAI and Gemini get it **hoisted** into a synthetic user message
right after the tool-result run. The hoist is the part worth testing — the ordering
invariant lives there.

> ⚠️ **Phrase the prompt forcefully.** The `read` tool's description still says *"Read a
> text file"*, so a model asked politely to "read this screenshot" will often **decline to
> call the tool at all** and answer "I don't have a tool to read image files." That is the
> tool description talking, not the feature failing — verified live on `claude-haiku-4-5`.
> Every prompt below is worded to force the call. (Worth a follow-up: the description should
> mention images.)

### 1a. Anthropic — native nesting

```bash
minima-loc --wt new-features-research --model claude-haiku-4-5 --provider anthropic
```

Then type:

```
You MUST call the read tool with path=/tmp/minima-test.png. Do not refuse. Then tell me exactly what text you can see in the image.
```

| ✅ expect | ❌ fail |
| -- | -- |
| The model describes the actual screenshot contents | "I can't view images" *after* actually calling `read` · a 400 error · `read: image file not supported` |

The transcript row for the tool call shows `[image] /tmp/minima-test.png (image/png, NNNNN bytes)` —
that descriptor line is what lands in SQLite; the base64 never does.

### 1b. OpenAI — the hoist

```bash
minima-loc --wt new-features-research --model gpt-4o --provider openai
```

Same prompt. Same expectation. This is a **different code path** from 1a — if 1a works and
1b doesn't, the bug is in `hoistToolResultImages` (`src/ai/compat.ts`), not in `read`.

*(1a–1c were each verified live against a 1×1 PNG while writing this guide — all three
answered `SAW_IMAGE`. If one of them fails for you, it is your image or your key, not the
wiring.)*

### 1c. Gemini — the hoist again, different serializer

```bash
minima-loc --wt new-features-research --model gemini-2.5-flash --provider google
```

Same prompt, same expectation.

### 1d. Two images in one turn — the ordering invariant

Any of the three models above. First make a second image:

```bash
screencapture -x /tmp/minima-test-2.png
```

Then:

```
You MUST call the read tool on /tmp/minima-test.png and on /tmp/minima-test-2.png. Do not refuse. Then tell me how the two images differ.
```

| ✅ expect | ❌ fail |
| -- | -- |
| The model compares both | A 400 from OpenAI about tool messages / `tool_call_id` — that means the synthetic user message was inserted *between* two tool results instead of after both |

### 1e. Text-only model — fail-closed refusal

```bash
minima-loc --wt new-features-research --model gpt-5.6-sol --provider openai
```

```
You MUST call the read tool with path=/tmp/minima-test.png. Do not refuse. Report the tool's exact output.
```

| ✅ expect | ❌ fail |
| -- | -- |
| `read: image file not supported: /tmp/minima-test.png` | A provider 400 · a silently empty result |

(These `gpt-5.6-*` seeds are marked text-only because their vision support was never
verified — fail-closed by design. The refusal is the feature working, not a bug.)

### 1f. Kill switch

```bash
MINIMA_TUI_IMAGES=0 minima-loc --wt new-features-research --model claude-haiku-4-5 --provider anthropic
```

```
You MUST call the read tool with path=/tmp/minima-test.png. Do not refuse. Report the tool's exact output.
```

| ✅ expect |
| -- |
| `read: image file not supported: /tmp/minima-test.png` — byte-identical to the pre-feature message, even on a vision model |

### 1g. Oversized image

```bash
dd if=/dev/urandom of=/tmp/big.png bs=1m count=5 2>/dev/null
printf '\x89PNG\r\n\x1a\n' | dd of=/tmp/big.png conv=notrunc 2>/dev/null
stat -f '%z bytes' /tmp/big.png      # 5242880 bytes
```

Then on a vision model:

```
You MUST call the read tool with path=/tmp/big.png. Do not refuse. Report the tool's exact output.
```

| ✅ expect |
| -- |
| `read: image too large (5242880 bytes; limit 3750000): /tmp/big.png — downscale it or inspect with bash` |

---

## 2 · Context meter (#324)

The status bar's `ctx%` now counts the **whole prompt the provider billed** — including
cached tokens, the system prompt and tool schemas — and auto-compaction fires on that same
number. Before this, the footer divided the bare *uncached* input by the window, which
undercounted by roughly 10× with prompt caching on.

⚠️ This changes **when the agent compacts**, not just a label. That is what makes the smoke
test worth doing.

### 2a. Read the segment

```bash
minima-loc --wt new-features-research --model claude-sonnet-4-6 --provider anthropic
```

Ask anything that takes a turn, e.g.:

```
list the files in packages/tui/src/tui and tell me which is largest
```

Look at status row 1, between the model name and the `↑`/`↓` token counts:

| state | segment | when |
| -- | -- | -- |
| measured | ` │ ctx 34% (68k/200k)` | steady state — the last assistant reply carried usage |
| estimated | ` │ ctx ~12% (24k/200k)` | leading `~` — messages appended since the last reply, or no reply yet |
| unknown window | ` │ ctx ?% (68k/?)` — `?%` in **yellow** | the model's context window could not be resolved |
| narrow terminal | ` │ ctx 34%` | your terminal is under 100 columns — parenthetical dropped |

| ✅ expect | ❌ fail |
| -- | -- |
| A number in the tens of percent after a few turns on a warm session | A confident `ctx 0%` · a `ctx 2%` that never moves (that is the old bare-`usage.input` bug) |

**Sanity check the absolute number.** The `68k` should be roughly `↑input + system prompt +
tool schemas`. On a fresh session with no work done it will already be several thousand
tokens — that is the system prompt and tool schemas, which the old chars/4 estimate was
structurally blind to. If it reads near zero on turn one, something is wrong.

### 2b. `route:` / `reason:` are now conditional

Still on the default run above:

| ✅ expect |
| -- | -- |
| No `· route:` and no `· reason:` segment — they render only when non-default |

Now force both non-default:

```bash
minima-loc --wt new-features-research --thinking medium --offline
```

| ✅ expect |
| -- |
| `· route: offline` and `· reason: medium` both reappear, and status row 1 still **does not wrap** — the footer stays exactly two rows |

Resize the terminal narrow and wide while a session is open and confirm the footer never
becomes three rows.

### 2c. Kill switch — reverts both halves

```bash
MINIMA_TUI_CONTEXT_METER=0 minima-loc --wt new-features-research --model claude-sonnet-4-6 --provider anthropic
```

| ✅ expect |
| -- |
| ` │ ctx 3%` — bare percentage, **no** parenthetical, no `~`, and `· route:` / `· reason:` render unconditionally again. The number is visibly *smaller* than 2a for comparable work — that is the old undercount, restored on purpose. |

### 2d. Auto-compaction names the number

Only if you have a long session handy. When auto-compaction fires:

| ✅ expect | ❌ fail |
| -- | -- |
| `Auto (context was 83% full) — …` — the actual percentage the footer just showed | `Auto (context was >80% full)` while the footer reads something unrelated |

---

## 3 · Desktop notifications (#323)

OSC 9 + terminal bell when a long turn finishes, a permission prompt is raised, or the
`question` overlay opens. Default threshold: a turn must run **10 s** before it notifies.

### 3a. Turn-end banner

```bash
MINIMA_TUI_NOTIFY_AFTER_MS=0 minima-loc --wt new-features-research
```

`=0` notifies on **every** turn, so you don't have to wait. Ask anything, then **click away
to another window** while it runs.

| ✅ expect | ❌ fail |
| -- | -- |
| A system banner reading `Minima finished your turn` (Ghostty, WezTerm, iTerm2, kitty all honour OSC 9) | Literal garbage like `]9;Minima finished your turn` printed into the transcript — that means the escape wasn't consumed |

If your emulator doesn't do OSC 9 you should still hear the bell.

### 3b. The 10 s threshold

```bash
minima-loc --wt new-features-research
```

Ask something trivial (`what is 2+2`) — under 10 s.

| ✅ expect |
| -- |
| **No** banner. A turn you watched land doesn't interrupt you. |

Then ask something that takes >10 s and look away.

| ✅ expect |
| -- |
| Banner. |

### 3c. Permission prompt

With permissions on (the default — do **not** pass `--dangerously-bypass-permissions`):

```
run `git status` for me
```

| ✅ expect |
| -- |
| A banner `Minima needs permission: bash …` the moment the prompt appears, regardless of how fast the turn was |

### 3d. tmux — the DCS passthrough

```bash
tmux new -s minima-notify
# inside tmux:
MINIMA_TUI_NOTIFY_AFTER_MS=0 minima-loc --wt new-features-research
```

| ✅ expect | ❌ fail |
| -- | -- |
| Banner still fires (the sequence is wrapped in tmux's `ESC Ptmux;…ESC \` envelope) | Escape-sequence debris in the pane |

tmux needs `set -g allow-passthrough on` in your config for this to work; if it's off, the
correct outcome is *silence*, not debris.

### 3e. Kill switch and headless cleanliness

```bash
MINIMA_TUI_NOTIFY=0 MINIMA_TUI_NOTIFY_AFTER_MS=0 minima-loc --wt new-features-research
```

| ✅ expect |
| -- |
| Silence on every path — turn end, permission prompt, question overlay |

Headless must stay byte-clean:

```bash
minima-loc --wt new-features-research -p "say hello" | LC_ALL=C grep -c $'\x1b]9'
```

| ✅ expect |
| -- |
| `0` — zero OSC 9 sequences. `notify()` no-ops without a TTY, so piped/captured output never gets control bytes. |

---

## 4 · `$EDITOR` composing (#325)

<kbd>Ctrl</kbd>+<kbd>X</kbd> <kbd>Ctrl</kbd>+<kbd>E</kbd> (readline's `edit-and-execute-command`)
and `/editor` hand the draft to `$VISUAL`/`$EDITOR`. <kbd>Ctrl</kbd>+<kbd>G</kbd> is
untouched — it stays Plan Overview.

Expected notices are **exact strings** from `src/tui/editor.ts`.

### 4a. vim — alt-screen editor, the happy path

```bash
EDITOR=vim minima-loc --wt new-features-research
```

Type a few words in the composer (do **not** press Enter), then press
<kbd>Ctrl</kbd>+<kbd>X</kbd> then <kbd>Ctrl</kbd>+<kbd>E</kbd>.

| ✅ expect | ❌ fail |
| -- | -- |
| The composer box title flips `prompt` → `prompt · ^X` the instant you press Ctrl+X · vim opens with **your draft already in the buffer** · vim accepts keys normally | Nothing happens · vim opens empty · vim opens but swallows/drops keystrokes |

Add several lines, `:wq`.

| ✅ expect |
| -- |
| `editor: draft updated.` · the composer repaints cleanly (no torn frame, no leftover vim screen) · the multi-line draft renders **inside** the composer box, not fused into the border or footer |

**Type fast inside vim** — hold a key down for a second. No keystrokes should be lost; if
they are, the harness's stdin reader is still consuming fd 0.

### 4b. `:cq` — the abort path

Same session. Type a long draft, Ctrl+X Ctrl+E, change something, then `:cq` (quit with
non-zero exit).

| ✅ expect |
| -- |
| `editor: exited non-zero — draft kept.` · your **original** draft is still in the composer, unchanged |

This is git's `git commit` contract — a non-zero exit is a deliberate cancel, and there is
no undo for a draft.

### 4c. Emptying the buffer

Ctrl+X Ctrl+E with a non-empty draft, then in vim: `ggdG` then `:wq`.

| ✅ expect |
| -- |
| `editor: buffer was emptied — draft kept.` · original draft still there |

### 4d. nano — inline editor

```bash
EDITOR=nano minima-loc --wt new-features-research
```

Ctrl+X Ctrl+E, type, save (<kbd>Ctrl</kbd>+<kbd>O</kbd> <kbd>Enter</kbd>), exit
(<kbd>Ctrl</kbd>+<kbd>X</kbd>).

| ✅ expect |
| -- |
| Same as 4a. nano does *not* use the alternate screen, so this exercises a different restore path. |

### 4e. GUI editor without a wait flag

```bash
EDITOR=code minima-loc --wt new-features-research
```

Ctrl+X Ctrl+E. `code` without `--wait` returns immediately.

| ✅ expect |
| -- |
| `editor: no changes — a GUI editor needs a wait flag, try EDITOR="code --wait".` |

Then the correct form:

```bash
EDITOR="code --wait" minima-loc --wt new-features-research
```

| ✅ expect |
| -- |
| VS Code opens the temp file; on close, `editor: draft updated.` |

### 4f. Missing binary

```bash
EDITOR=/nonexistent/editor VISUAL= minima-loc --wt new-features-research
```

Ctrl+X Ctrl+E.

| ✅ expect | ❌ fail |
| -- | -- |
| A notice, the draft intact, and the TUI still fully usable | A hang · a dead terminal · raw mode left off |

### 4g. `/editor` slash command

```bash
EDITOR=vim minima-loc --wt new-features-research
```

Type `/editor` and Enter → opens **empty** (the composer clears itself before the command
runs, so `/editor` cannot carry a draft — that is what the chord is for).

Then `/editor some starting text` → opens seeded with `some starting text`.

### 4h. Batched chord — the stdin fix

```bash
tmux new -s minima-editor
# inside tmux:
EDITOR=vim minima-loc --wt new-features-research
```

Press Ctrl+X and Ctrl+E **as fast as you can** so tmux batches both bytes into one chunk.

| ✅ expect | ❌ fail |
| -- | -- |
| vim opens | Neither key registers — the pre-fix behavior, where two adjacent control bytes in one stdin chunk matched no branch at all |

### 4i. Cancelling the chord costs nothing

Press <kbd>Ctrl</kbd>+<kbd>X</kbd>, then type `h`.

| ✅ expect |
| -- |
| The title hint `· ^X` disappears **and** an `h` is inserted into the draft — the cancelling key is not swallowed |

### 4j. Kill switch

```bash
MINIMA_TUI_EDITOR=0 EDITOR=vim minima-loc --wt new-features-research
```

Press Ctrl+X Ctrl+E:

| ✅ expect |
| -- |
| Nothing opens. Ctrl+X is swallowed as before, and **Ctrl+E cycles the thinking level** exactly as it did pre-feature. |

Type `/editor`:

| ✅ expect |
| -- |
| `$EDITOR composing is OFF — unset MINIMA_TUI_EDITOR (or set it to 1) to use it.` |

⚠️ `MINIMA_TUI_EDITOR` names a **behavior, not an editor**. `MINIMA_TUI_EDITOR=vim` leaves
the feature **on** with the value ignored — use `$EDITOR`/`$VISUAL` to choose the binary.
Only `=0` disables.

---

## Everything off at once

A last sanity pass — the published rollback contract is "with the feature off the harness
behaves exactly as it did before it existed":

```bash
MINIMA_TUI_IMAGES=0 MINIMA_TUI_NOTIFY=0 MINIMA_TUI_CONTEXT_METER=0 MINIMA_TUI_EDITOR=0 \
  minima-loc --wt new-features-research
```

| ✅ expect |
| -- |
| Indistinguishable from `0.14.5` before these four landed: bare `ctx N%`, `route:`/`reason:` always shown, `read` refuses images, no banners, Ctrl+E cycles thinking |

---

## If something fails

| symptom | first place to look |
| -- | -- |
| Image works on Anthropic but not OpenAI/Gemini | `src/ai/compat.ts` — `hoistToolResultImages` |
| `read` refuses on a model you know has vision | `Model.input` in `src/cli/main.ts` seeds — fail-closed, so an omission costs the feature |
| `ctx%` looks wrong | `src/tui/context_meter.ts` — `contextUsage()`; check whether `basis` is `exact`, `adjusted` or `estimated` |
| Footer wrapped to three rows | `src/tui/status.tsx` — `app.tsx`'s `footerHeight` and `layout.ts` `PANEL_STATUS_ROWS` both hard-assume exactly two |
| Notification debris printed as text | `src/tui/notify.ts` — `osc9Sequence` / the tmux passthrough wrap |
| Editor opens but drops keystrokes | `src/tui/editor.ts` — `detachStdin()` / `resetInputFilter()` ordering |
| Terminal left in a bad state after the editor | `printf '\033[r'` resets a leaked scroll region; then check the `finally` restore order in `runEditorSession` |
