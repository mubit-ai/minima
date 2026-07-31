# Tier 1 manual test guide

Manual checks for the four Track A — Tier 1 features (PRs #322–#325), all merged into
`research/new-features-research`. Every one of these is something `bun test` **cannot**
prove: they need a real terminal, a real provider, or a real editor.

Budget ~20 minutes for all four. Each section is self-contained — skip freely.

---

## Setup (once)

```bash
cd /Users/eldaru/Mubit/Minima/new-features-research
git pull --ff-only origin research/new-features-research
git log --oneline -6 | grep -cE '#326|#328'   # must print 2
```

⚠️ **The `git pull` is not optional.** Two fixes landed *after* the features themselves, and
§1 fails without either:

- `bb9cfa4` (#326) — before it, `read`'s description said *"Read a text file"* and models
  refused to call the tool on a PNG at all.
- `d41d307` (#328) — before it, every turn on a `gpt-5.6-*` model died with
  `HTTP 400 — Function tools with reasoning_effort are not supported`, which is what §1.e runs.

If §1 fails, check this first.

Everything below runs **from source** via your `minima-loc` function, which sources
`.env.harness` (provider keys) and execs `bun run …/packages/tui/src/cli/main.ts`:

```bash
minima-loc --wt new-features-research
```

Env overrides go **in front**, extra args after:

```bash
MINIMA_TUI_NOTIFY=0 minima-loc --wt new-features-research --model claude-haiku-4-5 --provider anthropic
```

Make two test images once — the repo ships none:

```bash
mk() { cat > /tmp/$1.html <<EOF
<html><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;height:760px">
<div style="font-family:Helvetica;font-weight:bold;font-size:110px;text-align:center;line-height:1.3">$2</div>
</body></html>
EOF
qlmanage -t -s 900 -o /tmp /tmp/$1.html >/dev/null 2>&1; }
mk vt1 "MINIMA<br>CODE: PLUM8842"
mk vt2 "MINIMA<br>CODE: FIG3317"
ls -lh /tmp/vt1.html.png /tmp/vt2.html.png
```

Two known codes, so "did the model actually see it" has an unambiguous answer and the
two-image check in 1d can prove it kept them apart.

**Deliberately *not* `screencapture`.** A desktop grab is ~2 MB (close to the 3.75 MB
refusal ceiling), dense enough that weaker vision models misread it, and it ships whatever
is on your screen to three provider APIs. Big high-contrast text isolates the harness from
the model's OCR quality.

---

## 1 · Image input (#322)

The `read` tool returns the image itself to models that accept image input. Anthropic nests
it in the tool result; OpenAI and Gemini get it **hoisted** into a synthetic user message
right after the tool-result run. The hoist is the part worth testing — the ordering
invariant lives there.

> ### 📊 Calibrate before you start — this check is stochastic
>
> Whether the model *dispatches* `read` on a PNG is a decision it makes from the tool
> description. `bb9cfa4` (#326) rewrote that description, which took measured dispatch from
> **4/9 to 8/9** across three models — a large improvement, **not a guarantee**. Measured on
> the merged branch:
>
> - `claude-haiku-4-5` — most reliable; dispatched every trial.
> - `gemini-2.5-flash` — occasionally still declines (~1 in 3).
> - `gpt-4o` — usually dispatches; declined once in four.
>
> **So: retry a failing check once or twice before filing a bug.** A single refusal is
> within normal variance. A model that refuses 3× in a row on `claude-haiku-4-5` is a real
> finding.
>
> **Separate two different failures.** *Refused to call the tool* is a prompt-guidance
> issue and the residual known gap. *Called the tool and misread the text* is the model's
> OCR quality — not the harness. The big-text images above exist to keep the two apart.
>
> Use natural phrasing. The old advice to write "You MUST… do not refuse" is obsolete —
> and it never worked anyway; the pre-#326 refusals happened *with* that wording.

### 1a. Anthropic — native nesting

```bash
minima-loc --wt new-features-research --model claude-haiku-4-5 --provider anthropic
```

Then type:

```
What code is shown in /tmp/vt1.html.png?
```

| ✅ expect | ❌ fail |
| -- | -- |
| `PLUM8842` | "I can't view images" / "use an OCR tool" — a refusal to dispatch (retry once) · a 400 error · `read: image file not supported` |

The transcript row for the tool call shows `[image] /tmp/vt1.html.png (image/png, NNNNN bytes)` —
that descriptor line is what lands in SQLite; the base64 never does.

### 1b. OpenAI — the hoist

```bash
minima-loc --wt new-features-research --model gpt-4o --provider openai
```

Same prompt, same expected `PLUM8842`. This is a **different code path** from 1a — if 1a
works and 1b doesn't *after a retry*, the bug is in `hoistToolResultImages`
(`src/ai/compat.ts`), not in `read`.

### 1c. Gemini — the hoist again, different serializer

```bash
minima-loc --wt new-features-research --model gemini-2.5-flash --provider google
```

Same prompt, same expected `PLUM8842`. This is the model most likely to decline on a first
try — retry before concluding anything.

### 1d. Two images in one turn — the ordering invariant

The highest-value check in this section, and the only one that exercises the coalescing
rule: OpenAI requires every `role:"tool"` message to sit in an unbroken run after the
assistant's `tool_calls`, so both images must be hoisted into **one** synthetic user
message placed after the *whole* run — never one message between them.

Any of the three models above:

```
Read /tmp/vt1.html.png and /tmp/vt2.html.png and tell me both codes and which file each came from.
```

| ✅ expect | ❌ fail |
| -- | -- |
| `PLUM8842` from `vt1`, `FIG3317` from `vt2`, **attributed to the right file** | A 400 from OpenAI about tool messages / `tool_call_id` — the synthetic message split the run · both codes reported but swapped, or only one image seen |

### 1e. Text-only model — fail-closed refusal

```bash
minima-loc --wt new-features-research --model gpt-5.6-sol --provider openai
```

```
Read /tmp/vt1.html.png and report the tool's exact output.
```

| ✅ expect | ❌ fail |
| -- | -- |
| `read: image file not supported: /tmp/vt1.html.png` | A provider 400 · a silently empty result |

(These `gpt-5.6-*` seeds are marked text-only because their vision support was never
verified — fail-closed by design. The refusal is the feature working, not a bug.)

This check used to die on `HTTP 400 — Function tools with reasoning_effort are not supported`
before `read` ever ran; #328 fixed that. If you see that 400 again, the model is missing
`tools_require_effort_none` on its seed — not an image problem.

### 1f. Kill switch

```bash
MINIMA_TUI_IMAGES=0 minima-loc --wt new-features-research --model claude-haiku-4-5 --provider anthropic
```

```
Read /tmp/vt1.html.png and report the tool's exact output.
```

| ✅ expect |
| -- |
| `read: image file not supported: /tmp/vt1.html.png` — byte-identical to the pre-feature message, even on a vision model |

### 1g. Oversized image

```bash
dd if=/dev/urandom of=/tmp/big.png bs=1m count=5 2>/dev/null
printf '\x89PNG\r\n\x1a\n' | dd of=/tmp/big.png conv=notrunc 2>/dev/null
stat -f '%z bytes' /tmp/big.png      # 5242880 bytes
```

Then on a vision model:

```
Read /tmp/big.png and report the tool's exact output.
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

Both segments used to render unconditionally; now they appear only when they carry news.

Still on the default run above:

| ✅ expect |
| -- |
| No `· route:` and no `· reason:` segment |

`reason:` is the thinking level, and `--thinking` is what moves it:

```bash
minima-loc --wt new-features-research --thinking medium
```

| ✅ expect |
| -- |
| `· reason: medium` in cyan. (`--thinking high` renders **yellow**; `off` is the default and stays hidden.) |

`route:` is the **routing mode**, and the only thing that moves it is
<kbd>Ctrl</kbd>+<kbd>R</kbd> — a toggle between `auto` (the default, hidden) and `confirm`:

| step | ✅ expect |
| -- | -- |
| press <kbd>Ctrl</kbd>+<kbd>R</kbd> | `· route: confirm` appears in yellow |
| press it again | the segment disappears |

With both showing, status row 1 must still **not wrap** — the footer stays exactly two rows.
Resize the terminal narrow and wide while a session is open and confirm it never becomes
three.

### 2b-i. What `--offline` shows — and why it is *not* `route:`

`--offline` bypasses Minima routing. It does **not** touch `route:`: routing *mode* and
routing *reachability* are different things, and the offline state has its own three signals.

```bash
minima-loc --wt new-features-research --offline
```

| where | ✅ expect |
| -- | -- |
| status row 1 | `model: gpt-4o-mini ▸ offline` — the **basis** segment, with the model name in **yellow** |
| status row 2 | red `[offline: routing disabled (offline mode)]` |
| transcript | `ℹ routing offline: routing disabled (offline mode) — ran gpt-4o-mini unrouted. /reconnect to retry.` |

⚠️ **That transcript line is the feature working, not an error.** It is the harness naming
the model it fell back to and how to get routing back. `route:` stays hidden throughout,
because `--offline` never changes the routing mode.

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
| A 400 naming `reasoning_effort` | `src/ai/provider_quirks.ts` — that model needs `tools_require_effort_none: true` on its seed |
| `ctx%` looks wrong | `src/tui/context_meter.ts` — `contextUsage()`; check whether `basis` is `exact`, `adjusted` or `estimated` |
| Footer wrapped to three rows | `src/tui/status.tsx` — `app.tsx`'s `footerHeight` and `layout.ts` `PANEL_STATUS_ROWS` both hard-assume exactly two |
| Notification debris printed as text | `src/tui/notify.ts` — `osc9Sequence` / the tmux passthrough wrap |
| Editor opens but drops keystrokes | `src/tui/editor.ts` — `detachStdin()` / `resetInputFilter()` ordering |
| Terminal left in a bad state after the editor | `printf '\033[r'` resets a leaked scroll region; then check the `finally` restore order in `runEditorSession` |
