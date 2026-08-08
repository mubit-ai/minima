# 0020 — A committed project config may only move a value toward the safer side

- Status: accepted
- Date: 2026-08-05
- Written by: MUB-228 · records MUB-231 as built

## Context

Every configuration surface the harness had before this was **uncommitted, and trusted precisely
because the user wrote it** — the project env files beside the code, and the per-user store. House
rule says never commit the former, and the per-user store is outside any repository.

A committed project file inverts that in one step. It arrives with `git clone`, written by whoever
authored the repo, which turns `git clone && minima` into an execution path the repo author
controls. The user has expressed no opinion about any value in it; they cloned a repository.

That inversion is the whole design, not a footnote on it. The two surfaces are *project-scoped*
in exactly the same sense and have *opposite trust* — the distinction [CONTEXT.md](../../CONTEXT.md)
exists to keep straight.

## Decision

**A committed project file may only move a value toward the safer side.** Each allowlisted key
declares a merge direction — the budget ceiling may only be lowered, the budget mode may only be
made stricter, the candidate pool may only be intersected — or it is explicitly neutral, in which
case it plainly shadows and fills a gap the user left.

This is the general rule, not a spend special case. It cuts *across* layer precedence in one
direction only: a project value safer than the user's wins even though it sits below them in the
order, and a project value less safe loses even where precedence would have let it shadow.

**An allowlist is the gate, not a blocklist.** Keys not on the list are ignored. A blocklist is a
promise to have thought of everything, and it is renewed silently every time someone adds a
setting.

**The clamp happens in the loader, before anything reaches the process environment.** The safety
property is then structural rather than diligent: no downstream read site *can* observe an
unclamped value, because none was ever written. The environment erases provenance — once a value
is env you cannot tell which layer set it, so a later pass could not re-derive what to clamp
against even if someone remembered to write one.

**Keys with no nameable safer side are excluded, not defaulted.** The thinking level, judge
sampling and the default model are absent from v1 — not because they are dangerous, but because
nobody could say which direction is safer. The list grows by argument.

**The kill switch is read from the user's layers only.** The project file cannot switch off its
own gate.

## Why this is surprising

Because every comparable tool does the opposite, and does it so consistently that the rule here
reads as an oversight. Git config, ESLint, EditorConfig and VS Code all resolve scope the same
way: **the more specific scope simply wins.** A reader who knows those tools — which is every
reader — arrives holding a model in which the project file beats the user's settings, full stop.

Encountering a project file that is read, parsed, allowlisted, and *then* refused for being less
safe than the user's value, the natural conclusion is that the merge is buggy. The fix that
suggests itself is "make the project file win, like everywhere else," which is one small commit
and removes the entire property.

The second surprise sits inside the first: the surfaces are *both* project-scoped. The env files
and the committed file describe the same directory, so a reader looking for the trust boundary
along the usual project-versus-global axis will not find one there. The boundary is
committed-versus-not, and nothing about the scope names says so.

## Rejected alternatives

**Project wins uniformly.** The convention above, and the one a reader assumes. Rejected because
it lets a cloned repository raise your budget ceiling — the user never agreed to spend that money,
and no interaction in the flow is the moment they could have. This is the alternative this record
principally exists to keep rejected.

**Allow everything except secrets.** Rejected because `git clone && minima` could then arrive
pre-set to bypass mode with steering off, and nothing in that sequence made it the user's choice.
The absence of credentials is not the same as the absence of authority.

**The full key set behind a per-repo trust prompt.** Rejected on house style: the harness is
fail-closed and silent, and does not prompt at startup. A prompt also mislocates the decision — it
asks the user to vouch for a file they have not read, at the moment they least want to read it.

**A dotted-env format, matching the per-user store.** Rejected because every value would be a
string, and the merge rules need a real number to take a minimum from and a real list to
intersect. **YAML** was rejected for type coercion in a file the whole team shares, and **JSON**
for having no comments — a committed config file's job is communicating team intent, so it must be
able to carry a sentence saying why.

**Clamping downstream, at each read site.** Rejected as the same class of promise as the blocklist:
it is correct only while every current and future reader remembers, and it is unfalsifiable at the
seam. Clamping in the loader makes the property testable as a pure function over two directories,
which is why the tests never manipulate the environment at all.

## Consequences

- **The file cannot do the thing project config files are for.** It cannot set up a project. It can
  only tighten what the user already permits, which means a repository cannot use it to say "this
  project needs a bigger budget" — the case a team will try first, and the one that will generate
  the bug report. That report will be correct about the behaviour and wrong about the defect.
- **Refusals must be visible or the rule teaches nothing.** A refused value is reported to the
  user, as is a key that is not on the allowlist. Silence is the wrong default for a file someone
  else committed: the user needs to know both what it changed and what it was not allowed to
  change. A project value that merely *agrees* with what is already in effect is a no-op and says
  nothing — reporting it every startup would train the user to ignore the line that reports a real
  refusal.
- **An empty result is a refusal, not an answer.** Intersecting the candidate pool to nothing is
  rejected rather than written, because an empty pool is an *absent* constraint — it would widen
  routing at the exact moment the file appeared to be narrowing it. This is the general failure
  mode of directional merges: for most keys there is a value whose meaning flips from restriction
  to absence, and it has to be found per key rather than assumed away.
- **The allowlist's growth is the real interface.** Every key added has to arrive with an argument
  about which direction is safer, and some settings may never acquire one. The v1 list is short
  because that argument had only been made four times, not because four keys are enough.
- **This could not be another gap-filling pass on the existing chain.** Clamping needs the project
  and user values in hand simultaneously, whereas the old loaders filled gaps in sequence and the
  per-user store hydrated last. The rule forced a single resolution over all layers — a structural
  consequence of rule three, paid once.
