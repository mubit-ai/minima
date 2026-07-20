# Plan C — Instant user-prompt echo (standalone)

> **Status:** ready to execute. **Execution order:** LANDS FIRST — fully independent of Plans A
> and B; no sidebar or renderer dependency. **Size:** S–M.
> **Worktree:** `/Users/eldaru/Mubit/Minima/minima-j1` · **Branch:** `feat/BP-UX` (own commit;
> flows into the open PR) · **Validated at SHA:** `1bd27b3` (re-pin at execution time).

A real, confirmed bug. Split out of the prior bundled plan because it has zero dependency on the
sidebar or the renderer default — it's a backend/behavior fix in `app.tsx` and should land on its
own so a bisect can isolate it and so the high-value, low-risk win isn't held hostage behind the
riskier sidebar restructure.

---

## Context (root cause, validated against the code)

`onSubmit` (`packages/tui/src/tui/app.tsx:3459`) **never echoes the submitted prompt**. It clears
the input, records history, and — for non-slash prompts — goes straight to `setBusy` / route
dispatch (`app.tsx:3486` → `try` at `3495`), which calls `agent.promptRouted(expanded)` at
`app.tsx:3516`.

The user row is produced only as a **side-effect of the agent event stream**: the `message_start`
handler at `app.tsx:1428-1431` pushes `{ role: "user", text: ev.message!.textContent }` when the
agent emits its user-role message. That emission happens only after the recall-before-route
round-trip in `promptRouted` (`src/minima/runtime.ts:193` → `memory.recall(content)` at
`runtime.ts:222`, then route). So for the duration of recall+route (and in plan mode, for the
entire council round — `plan_turn.ts`) **the submitted prompt is rendered nowhere.** Pre-loop
errors (route failure) lose the echo entirely.

A second symptom falls out of the same path: `message_start` carries `textContent`, which for the
normal loop is the **`@file`-expanded** content (`expandAtFiles(text, ...)` at `app.tsx:3515`
runs before `promptRouted`). So users see an expanded blob, not what they typed.

## The fix (optimistic echo + dedup ref)

Push the **verbatim** trimmed text the instant the user hits Enter, and de-duplicate against the
later `message_start` event with a ref so it isn't echoed twice.

**C1. Ref declaration.** Near the other refs (e.g. next to `thoughtsRef` at `app.tsx:1421`):
`const pendingEchoRef = useRef(false);`

**C2. Optimistic push in `onSubmit`.** After the slash-command early-return (`app.tsx:3483`) and
before `setBusy(true)` (`app.tsx:3486`) — i.e. it covers **both** the plan-turn path (`3497`) and
the normal-loop path (`3516`):
```ts
setMessages((m) => [...m, { role: "user", text: trimmed }]);
pendingEchoRef.current = true;
```
The verbatim `trimmed` (`app.tsx:3477`) is what the user typed — not the `expanded` blob.

**C3. De-dup in the `message_start` handler.** `app.tsx:1428-1431`: if the ref is set, clear it
and **skip** the push (the optimistic echo already landed; the event carries expanded content we
do not want to double-post):
```ts
case "message_start":
  if (ev.message?.role === "user") {
    if (pendingEchoRef.current) { pendingEchoRef.current = false; break; }
    setMessages((m) => [...m, { role: "user", text: ev.message!.textContent }]);
  }
  break;
```

**C4. Clear in `finally`.** `app.tsx` `onSubmit` `finally` block (starts `3529`): add
`pendingEchoRef.current = false;` so a route error / early throw can't leave the ref set and cause
a *later* unrelated `message_start` to be wrongly skipped.

### Effects (all intended, each gets a test or a PTY check)
- Prompt visible **instantly**, before recall+route resolves.
- Plan-mode ordering fixed: the optimistic user row lands *before* `handlePlanTurn` runs, so user
  text precedes council notes.
- Pre-loop route errors no longer lose the prompt (the optimistic row is already in state).
- `@file`-expanded blobs no longer echoed (verbatim is shown instead).
- The finalize build-handoff prompt still echoes normally — by the time it runs the ref has been
  cleared by C4, so its `message_start` pushes as before.

### Invariant to enforce (dev-check, not a user-visible guard)
Input is blocked while a turn is in flight (the busy gate), so at most one prompt is pending.
Assert in C2 that `pendingEchoRef.current === false` before setting it (a cheap
`if (pendingEchoRef.current) console.warn(...)` or a test-only invariant) — a double-fire would
silently drop a message and that regression must be loud.

---

## Tests (`packages/tui/tests/behavior.test.ts`, house source-pin style)

1. `pendingEchoRef` declaration present (`useRef(false)`).
2. `onSubmit` optimistic slice pinned verbatim: the `setMessages((m) => [...m, { role: "user", text: trimmed }]);` immediately followed by `pendingEchoRef.current = true;`, located after the slash `return;` and before `setBusy(true)`.
3. De-dup slice pinned: `if (pendingEchoRef.current) { pendingEchoRef.current = false; break; }` inside the `message_start` user branch.
4. Finally-clear pinned: `pendingEchoRef.current = false;` inside the `onSubmit` `finally`.
5. Count invariant: `pendingEchoRef.current = true` occurs exactly **once** (the set); `= false` occurs in the de-dup, the finally, and the `useRef(false)` initializer.
6. Existing `message_start` user-push string `{ role: "user", text: ev.message!.textContent }` still present (the skip doesn't remove it).

## Verification

1. `cd packages/tui && bun test && bun run check && ./node_modules/.bin/biome check src`
2. **PTY shot** (zero-spend mock provider, e.g. the `/tmp/minima-mock.mjs` SSE harness, or a
   deliberately slow mock): submit a prompt and capture a frame *before* any reply arrives — the
   user block must be visible. Save under `docs/BigPlan/shots/c-prompt-echo.png`.
3. Plan-mode echo-ordering shot (optional but recommended): in plan mode, prompt → frame shows
   user row above any council/tool rows.
4. Commit `fix(tui): echo the user prompt optimistically so it's visible before routing resolves`
   + push `feat/BP-UX`.

## Risks

- **Double-echo** if C3's skip is bypassed. Mitigated by the ref + the finally clear + the count
  invariant test. The dev-check in C2 makes a regression loud rather than silent.
- **Wrong text shown for `@file` prompts** if someone later wires the optimistic push to `expanded`
  instead of `trimmed`. The test pins `text: trimmed`, which guards this.
- **Interaction with the busy gate**: if a future change allows a second prompt while one is in
  flight, the single-slot ref breaks. That change would be a larger UX shift and should revisit
  this design; the dev-check surfaces it.
