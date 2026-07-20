All three new docs read (inline-rendering-brief.md, decision-inline-renderer.md, tui-rendering-strategy.md). Before the roast, three facts the brief doesn't know, because it was validated at 1bd27b3 and the tree is now at 4e7d989:

- D1 (prompt echo) already shipped — PR #133 is merged into feat/BP-UX. The brief's "ship first" item is done.
- The sidebar it says was "never written" was written, merged (#135), and is live in fullscreen — chassis, docked layout, narrow overlay, auto-open at ≥100 cols. "Opting out" now means disposing of landed code, not skipping future work.
- PR #131 (feat/BP-UX → main, 60 commits) is still open and contains all of it.

Now the roast — 60 questions. Answer by number, shorthand is fine (Q7: yes, Q24: default). Where I state a default, silence = I take the default.

A. Disposal of what you already paid for

- Q1. PR #131 to main is open and carries the sidebar you're now abandoning. Merge as-is and build inline on top (my default — history is history), or rework it before merge? Reworking 60 commits to erase a feature you'll keep as "legacy opt-in" anyway is pure cost — convince me otherwise.
- Q2. Pick the opt-out strength: (a) sidebar stays reachable in fullscreen as legacy; (b) remove only the auto-open; (c) reroute Ctrl+T/Ctrl+G to inline panels in both renderers, leaving the docked sidebar unreachable dead code; (d) delete the sidebar code outright. The brief implies (c) but also says "don't rip out" — (c) means shipping a corpse. Which is it?
- Q3. The chassis look (borderless, cwd + ● Minima 0.10.0 footer) — reuse SidebarChassis inside the inline D3 panels so the OpenCode aesthetic survives, or is the look dead too?
- Q4. Confirm the guide marks D1 done and mini-project #1 is the scrollback spike — or do you dispute that the merged echo fix fully covers pr-prompt-echo.md?
- Q5. The brief's header contains two falsehoods (supersedes a doc it claims was never written; treats D1 as unshipped). Its own §6 says "edit this file, don't fork." Do I correct it as part of writing the guide?
- Q6. PLAN.md says "this file wins" and records U2/U3 ✅ as fullscreen overlay panels — now contradicted by the brief. Do I update PLAN.md (§5b decided-design + status rows) to point at the brief, and does the new guide become a child of PLAN.md or a peer that wins on rendering topics? Two "this file wins" documents is how you got here.
- Q7. docs/BigPlan/shots/ after-shots show the docked sidebar as the good state. Recapture an inline baseline set (before any D2/D3 code) as the new visual reference — yes?
- Q8. The ≥100-cols auto-open effect: remove, or leave as fullscreen legacy behavior?

B. Legacy-fullscreen policy

- Q9. --fullscreen stays forever silently, or prints a "legacy, unmaintained" warning? Silent legacy code rots into support tickets.
- Q10. make tui-verify is five fullscreen scenarios. The new product surface is inline with zero PTY gating. Add inline scenarios with their own perf budgets (my default), and do the fullscreen ones stay blocking or become non-gating?
- Q11. /rewind: overlay picker in fullscreen, numbered list inline. Once D3b exists, does /rewind get promoted to an inline panel (consistency) or stay a numbered list (scope guard)? My default: stay, revisit after D3b ships.
- Q12. Terminal support floor: is Terminal.app in or out? It decides emoji-width handling, wheel behavior, and how much the manual tests cover.
- Q13. The strategy doc's ?1007h alternate-scroll spike was a fullscreen-trackpad fix. Fullscreen is legacy now — that item dies, correct?

C. The spike (your "verify rendering before building on broken code")

- Q14. Spike pass criterion — is "raw PTY byte stream contains no CSI 3 J AND pre-panel scrollback lines are still present after open→scroll→close" the bar? On which terminals — pyte harness only, or also live iTerm2?
- Q15. For real D3b height: what's inside footerChrome — input + status bar + collapsed D3a + suggestions row? And does opening D3b hide D3a (my default: yes, it is the expanded D3a)?
- Q16. Resize while a tall panel is open can push the live region to rows → wipe. Is clamp-on-resize part of the spike's scope or the first D3b project?
- Q17. Streaming while the panel is open: (a) panel auto-closes on stream start, (b) stream renders beneath and the panel shrinks by the stream-tail budget, (c) stream is invisible until close. Pick — this decides the height math for everything.
- Q18. A near-full live region is repainted every frame — the same cost class fullscreen was criticized for. Should the spike also measure frame cost under MINIMA_TUI_PERF so we don't reinvent the perf problem we just escaped?
- Q19. If the spike fails, the brief's fallback is print-once snapshots. Do I write the guide with both branches pre-planned, or do we stop-the-line and replan together? My default: both branches, clearly gated.

D. D3a — compact footer panel

- Q20. Data: PlanSessionStore is the GT plan. When GT is off but the agent uses plain todowrite, does D3a still render the todo list (Claude-Code parity — my default), or is it GT-only?
- Q21. Row budget: how many rows max? And content — current step only, current+next, or all steps windowed?
- Q22. On by default, or opt-in? Toggle key? Does its open/closed state persist in ui-modes.json?
- Q23. No plan and no todos → zero rows (my default) or a one-row hint?
- Q24. The footer already has a GT plan-projection banner with DRIFT. D3a replaces it (my default — two plan surfaces in one footer is noise) or they coexist?
- Q25. Tier icons 🟢🟡🔴 and DRIFT shown in D3a rows, or reserved for Ctrl+G?
- Q26. Exact stack order above the input: suggestions / busy / D3a / input / status — where does D3a sit?

E. D3b — the full panel

- Q27. The biggest hole in the brief: inline cannot programmatically scroll the terminal's scrollback, so ToC "Enter jumps to section" is unimplementable as written. What does Enter do: (a) re-print the section's messages into scrollback as a one-shot block, (b) read the section inside the panel (panel becomes a reader), (c) browse-only, no Enter action? This one decision shapes D3b's whole design.
- Q28. GT panel Enter → step detail card inside the panel (U3 model, ported) — confirm.
- Q29. While D3b is open the composer is suspended but the draft survives (U2's suspended TextInput) — reuse as-is, confirm.
- Q30. Chord semantics stay U2/U3-identical: Ctrl+T toggles ToC, Ctrl+G swaps to GT, Esc back to composer — confirm.
- Q31. The 🔴 gate-answer modal shares Ctrl+G; unanswered-gate-wins-the-chord stays, confirm.
- Q32. Content grows live while open (new sections mid-stream). Cursor stays anchored to its item, not its index — confirm, or is live-update-while-open overkill for v1?
- Q33. Panel scroll keys: j/k, arrows, PgUp/PgDn, g/G — and definitively no mouse capture in inline, ever?

F. D2 — message rendering

- Q34. Three days ago you chose "keep current look" for the user block. D2 proposes an accent-bar restyle. Which decision stands? Reversals are fine; undocumented ones are how contradictory briefs happen.
- Q35. Rank what actually bothers you in today's transcript: role headers, spacing/density, code blocks at narrow width, tool-result noise, markdown fidelity, streaming flicker. Top two get mini projects; the rest wait.
- Q36. Syntax highlighting in code blocks — in or out? It costs a dependency and per-frame work in the live region.
- Q37. Long tool outputs: once committed to <Static> scrollback they're immutable — "collapse/expand" can only mean expand-by-reprint. Keep today's truncation, or design expand-by-reprint?
- Q38. Minimum cols the transcript must stay readable at — 60? 45? This bounds every wrap decision.

G. Jump-to-message (D2b)

- Q39. Given Q27, is Ctrl+J jump still a separate feature, or does D3b-as-reader make it redundant? My default: fold it into D3b and kill Ctrl+J.
- Q40. If it survives: fuzzy text search or a numbered prompt list (like /rewind's)?
- Q41. Jump targets: user prompts only (section anchors), or any message including tool results?

H. The full plan workflow (your point 4)

- Q42. Name the top pain in planning mode today, one sentence each: entering (Shift+Tab), the ask-every-time permission prompts, council latency, plan visibility, approving, exiting to build. I won't design fixes for pains you don't have.
- Q43. The /plan design council: keep, make optional, or streamline? It's the single biggest latency block in plan mode.
- Q44. Plan approval: today the plan appears via todowrite and execution just proceeds. Do you want an explicit approve/edit gate in the TUI before execution (shown via D3b), CC-ExitPlanMode-style?
- Q45. verify commands are LLM-authored shell that the harness executes. Where does the user see/consent to them — once at plan approval, per-step at first run, or trust-the-gate as today? This is a security-UX question, not cosmetics.
- Q46. During execution, what must be visible without pressing Ctrl+G: current step, red→green state, DRIFT, cost-so-far, model in use? Your answer is D3a's exact content spec.
- Q47. 🔴 stop-and-ask in inline: footer question prompt (existing QuestionOverlay pattern) with evidence one Ctrl+G away — right model?
- Q48. Should D3b's GT panel become the primary /why surface, with the text /why as fallback — or keep them separate?
- Q49. Per-step cost + model (U3's v8 stamp work) — port into the inline GT panel as-is, or trim to cost-only?
- Q50. Should the ToC mark sections where a gate failed (❌/tier icon on the section row) so failures are findable in history?
- Q51. Scope guard: is this guide strictly presentation-layer (my default — loop/ledger/routing changes out of scope except read-only queries a panel needs), or do you want loop-behavior changes (e.g. escalation on failed verify) in scope too?

I. Mini-project logistics

- Q52. "Projects I can work on myself" — you write the code and I spec/review, or do we split? This decides how much scaffolding detail each project doc carries.
- Q53. Target size per project: one sitting (~2–4h)? Every project ends with manual-test script + bun test + PTY shot — confirm.
- Q54. Strict linear sequence, or two tracks (D3 chain strict: spike→D3a→D3b; D2 parallel)? My default: two tracks.
- Q55. Branching: one branch + PR per mini project, targeting feat/BP-UX until #131 merges, then main? Gate per brief §8?
- Q56. One Linear issue per mini project under Minima – Big Plan?
- Q57. Guide shape: one file docs/BigPlan/inline-ux-guide.md with a section per project (my default), or one file per project?
- Q58. Your point 2, made concrete: every mini project starts by writing its verification artifact (PTY spec or failing test) before any implementation — red→green, same discipline GT imposes on the agent. Mandatory for every project, confirm?

J. Define "smooth"

- Q59. "Smooth and UX great" must be measurable or it's vibes. Which do you actually care to gate on: prompt-echo latency (already fixed — <1 frame), no streaming flicker, panel open/close < 1 frame, cold-start time, frame cost under MINIMA_TUI_PERF? Pick the ones that become tui-verify budgets.
- Q60. What's your real daily setup — terminal app and typical cols×rows? Manual test scripts should match how you run it, not a hypothetical 80×24.

1. You can abondon or rework it but we will not use fullscreen as after trying it, it feels broken.
2. go with d, here is the justification /Users/eldaru/Mubit/Minima/minima-j1/docs/BigPlan/decision-inline-renderer.md
3. Rework / remove the whole SidebarChassis approach. Stick with the Claude Code inline UI / UX approach.
4. Make sure the issue is fixed, if it was confirmed to be fixed, then continue
5. Check it and correct it if needed in the guide
6. Everything in PLAN.MD was supposed to be done, and rn we are building a different plan that should fix issues that were found after the PLAN.MD was implemented. You can retire and rename PLAN.MD
7. We need new visual refference / confirmation
8. Remove anything fullscreen related
9.
10. I might need to use PTY when working on mini projects
11. stay, revisit after D3b ships
12. Terminal.app out
13. yes
14. Split them: bytes → pyte (automate forever), outcome+function → one live iTerm2 pass (confirm once)
15. footerChrome when D3b is open is just input + status bar (suggestions/busy suppressed, D3a hidden as the collapsed state of the same panel); footerChrome when D3b is closed adds D3a. D3b hides D3a — confirmed.
16. D3b mounts ABOVE the still-visible prompt: the ToC/Plan Overview fills the live region above a usable prompt (chat stays dormant in scrollback above — backgrounded, not erased), Esc returns full focus to the prompt; so footerChrome-when-open = prompt + status bar, D3a is hidden, and the panel gets rows − (prompt + status bar).
17. Pick (a): the panel auto-closes when a stream starts, so panel height stays static at rows - footerChrome, the streaming path is untouched, and nothing stacks near the wipe threshold. (b) is a possible later enhancement only if browse-during-stream proves to be a real need
18. Yes — the spike should record MINIMA_TUI_PERF during its PTY run (the probe already exists, the run is already happening, it's free), because a near-full live region is the same repaint cost class as fullscreen and we went inline explicitly to escape that; treat the spike's number as a lower bound and compare it to the existing fullscreen budget, with React.memo + update-on-change as the mitigation if it's hot.
19. go with default, but split the gate's failure output: expected-fail → snapshot branch, surprising-fail → stop-the-line and replan together; and name a third outcome for a partial pass (clamp to a safe height, re-measure).
20. CC-parity: render todos whenever they exist by reading todowrite's state directly (todowrite.ts:32) — GT stays an opt-in enrichment (richer ledger view), not the gate that turns D3a on.
21. Cap D3a at a fixed ~3 rows showing progress + current step (+ next only if it fits) — keep it a fixed constant so footerChrome stays predictable and clear of the wipe threshold; don't window all steps here, that's D3b's job.
22. On by default and auto-shows when tasks exist (empty = no panel); toggle with Ctrl+B (+ /tasks command); persist only the user's explicit override per-project in the existing ~/.minima-harness/ui-modes.json (mode_prefs.ts), so a hide survives restart while new projects get the auto-show default.
23. Zero rows when empty (your default) — it respects the live-region budget, matches CC, and the auto-show-on-first-todo behavior is itself the onboarding; teach the feature via the startup tip + command palette + status-bar key hint instead of a permanent row.
24. D3a replaces the GT display banner (planStrip projection + drift + 🟡/🔴 rows fold INTO D3a's enriched view — drift as a per-step badge, tiers as alert rows) so there's one plan/task surface, not two; but the gate-focus MODAL (gateFocus) coexists — it's a triggered answer interaction, not a parallel surface, and the 🔴 indicator in D3a still routes to it.
25. Active alerts (a live 🔴 block or drift > 0) surface in D3a as colored text/ASCII — not the wide circle emoji — so they stay visible without per-row width risk; per-step tier decoration (🟢🟡🔴 on every row) is reserved for Ctrl+G, where there's room for the full tiered view.
26. D3a sits at the TOP of the footer stack (persistent reference → stable, doesn't jump when transient elements toggle), with busy + suggestions moved to sit immediately above the input (suggestions are completions — they should hug it, not float at app.tsx:4086); it replaces the GT banner rows (Q24) and the addition is the right moment to fix that suggestions/input separation.
27. (b)
28. confirmed
29. confirmed
30. confirmed
31. confirmed
32. Snapshot at open for v1 (your instinct is right) — the panel reads via the pure buildGtOverview/sections call on open and re-reads on reopen, so the cursor stays trivially index-based (no identity-anchoring needed); live-update-while-open is largely moot under Q17a's auto-close-on-stream anyway, and the v1.5 escape hatches (stale indicator, refresh key, re-read-on-close) come before full live-subscribe + identity-cursor, which is v2.
33. Bind the full set — j/k, ↑/↓, PgUp/PgDn, gg/G — all mapping to one cursor/scroll primitive (cheap, expected, conflict-free while the panel owns keys); and yes, hard rule: inline never captures the mouse, because keys cover panel scroll and capture would break the native select/copy/scrollback that is inline's whole point (the wheel scrolls the terminal's scrollback — that's the feature, not something to hijack)."
34. Pick one and document it
35. IDK
36. Out for v1 — it's a dependency plus per-frame live-region work (the Q18 repaint cost); nail code wrapping first, treat highlighting as additive v2 only if the perf budget allows.
37. Keep truncation-at-commit with a '…N more lines' indicator; expand-by-reprint pollutes scrollback with duplicates (the Q27a hazard), and if expand ever matters it belongs in a panel-reader (Q27b model), not a scrollback reprint — so v1 = truncate, defer the rest.
38. Min readable width = 60, matching the existing TOC_MIN_COLS (layout.ts:537) — one consistent floor across the TUI; below 60 degrade to text-snapshot, at/above render fully. 45 is too low for code-heavy content
39. Fold into D3b and kill Ctrl+J — Q27 made 'jump = scroll' impossible, so any jump must be a reader-in-panel, which D3b already is; a separate Ctrl+J would duplicate D3b's reader for no gain, and the only salvageable idea (a fast-picker entry) becomes a mode of D3b, not a feature.
40. Moot once Q39 folds jump into D3b — the picker IS D3b's existing ToC list (j/k nav, the numbered/section model), so there's no separate fuzzy-vs-numbered call to make for v1; fuzzy becomes a v2 type-to-filter enhancement inside the ToC, only if convos get too long to scan.
41. User prompts only (section anchors) — it matches the existing ToC section model, tool results are nav noise (you reach them by reading the section, not jumping to them), and coarse prompt-level anchors match how users actually think ('go to the auth question'), not 'message #47.'
42. - Council latency: "Every plan turn blocks on the full researcher→keeper→critic→synth council round before the planner replies, so the user stares at a busy spinner for a multi-model round-trip with no incremental progress signal — the single most-felt pain, and the prompt-echo fix didn't touch it." - Plan visibility: "The plan is invisible until /plan finalize writes GROUND_TRUTH.md — during planning you get council notes and step strips but not the coherent evolving document, so you can't tell whether the plan is converging or scattered, which is a serious flaw in a tool whose whole job is planning."
43. Streamline — keep the council-before-planner sequence (the council improves the plan, so show the improved plan, not a worse draft first), and kill the latency by streaming the council's progress visibly as it runs, parallelizing the independent roles (researcher + critic concurrent, synth last), and convening the full council conditionally on plan-stakes turns only — not "keep" (ignores the pain) and not "optional" (a cop-out that lets users disable GT's core value).
44. Yes — adopt an explicit approve/revise/cancel gate (CC-ExitPlanMode-style) as the universal plan-mode exit, shown via D3b so the plan and its approval live in one surface; you're not inventing it — GT already has it (exit_plan.ts 3-option overlay + /plan finalize) — so the work is lifting the GT-only registration so it fires in plan mode regardless of GT, with v1 = approve/revise/cancel (not full inline step-editing, which is v2).
45. Per-command consent at first run — verify is LLM-authored shell (same class as the bash tool) AND it's mutable (todowrite.ts:51, sticky-but-overwriteable), so bind consent to the exact command string at first execution via the existing permission overlay (allow-always sticks per exact command, re-prompts on change), and surface the commands in D3b at plan approval for visibility — not trust-the-gate (an auto-exec bypass of bash-level scrutiny) and not once-at-approval (batch rubber-stamp + consent drift on mutated verifies)
46. D3a shows current step + progress (+ cost-so-far as a trailing compact element, since Minima is cost-focused and the status bar only has per-turn cost), plus a conditional alert row for active 🔴/🟡/DRIFT (colored text per Q25); exclude model (already in the status bar) and per-step tier icons/full list (those are Ctrl+G) — so D3a = 'what's happening + what needs attention,' everything else is a keystroke away.
47. Yes
48. yes
49. as-is
50. sure
51. I want to validate loop/ledger/routing, and make sure it makes sense for the whole plan end to end process.
52. I will work on one mini project at a time (tailor it for agent), I want agent to test is via PNG, and then I want to test it manually myself. Then I will compact my work so far and move to the next mini project.
53. confirm
54. yes, 2 tracks
55. confirm
56. confirm
57. confirm
58. confirm
59. Gate on four budgets, all PTY/MINIMA_TUI_PERF-assertable: frame cost (backbone), prompt-echo ≤ 1 frame (regression guard for D1), panel open/close ≤ 1 frame (instant transitions), and zero clearTerminal during stream/panel-ops (the measurable flicker+wipe proxy, doubling as the Q14/Q18 guard) — cold-start is tracked separately, not a smoothness budget, and 'flicker' as vibe isn't assertable, only its no-full-repaint proxy is.
60. Test matrix = your real daily app + cols×rows as the primary target (where rendering must be flawless), plus two degradation edges — the 60-col Q38 floor and a tmux-split-narrow case (to validate the text-snapshot fallback) — never a hypothetical 80×24; give me your actual app and size and that's the primary, with the edges as the regression bookends.
