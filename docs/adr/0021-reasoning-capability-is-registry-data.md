# 0021 — Reasoning capability is registry data, never a per-provider rule

- Status: accepted
- Date: 2026-08-05
- Written by: MUB-228 · carries the `/domain-modeling` session's decision on "effort" · consumed by MUB-229

> **Scope.** This records *our* mechanism, on our branch. The disposition of the two open PRs that
> fixed the same defect is MUB-227's to agree with their author, and is deliberately not decided
> here — an ADR is a record of an agreement, not a verdict on someone's open work.

## Context

One defect started this: a reasoning model 400ing with *"Function tools with reasoning_effort are
not supported"*. Two people fixed it independently, two different ways, and both fixes were open at
once. They overlap on exactly one line, which is the tell that they are not two versions of one fix
but two different theories of what the field means.

The theories divide on a question [CONTEXT.md](../../CONTEXT.md) now names: is a model's reasoning
capability a **claim about the model**, or a **mechanism for controlling requests**? The alternative
mechanism sets the capability claim to false in order to trigger an off-switch — which also removes
that model from the router's reasoning-capable pool, as a side effect of a wire-level fix.

## Decision

**Wire *shape* is per-provider. *Whether to send* is per-model.**

Shape belongs in the provider quirks table because it is a property of the protocol — the three in
use disagree about how effort is expressed, and one of them can express *off* by a mechanism the
others lack. Whether a given request should carry effort at all is a property of the model, held as
registry data on the model itself, alongside the capability claim and the image-input claim that
already work this way.

**A capability claim states what a model is. It is never overloaded into an off-switch.** A model
that reasons keeps a true reasoning claim even when a particular request must suppress effort;
suppression is expressed by its own field, and the router's view of the model is untouched.

This is the same doctrine already applied twice in the same table: the adaptive-thinking shape and
image input are both registry data, explicitly *"not an id-pattern list here"*
(`provider_quirks.ts:42`, `:55`).

## Why this is surprising

The per-provider version is the intuitive one. The failing parameter is an OpenAI-family parameter;
the natural inference is that the rule belongs to the provider that defines it. It is also less
code, needs no registry migration, and generalises to every model on that provider without anyone
declaring anything.

The strength of the evidence here is unusual and worth stating plainly: **a colleague independently
built the per-provider version against a codebase in which the reason not to was already written
down, as a comment, at `provider_quirks.ts:69`** —

> *not an id-pattern list here — and never a per-provider rule, since gpt-4o on the same provider
> 400s on the parameter itself.*

The comment was not wrong, not stale, and not hidden. It sits directly above the function the fix
had to touch. It simply was not where the decision got made, and a comment beside an
implementation cannot reach someone forming a design in their head before they open the file. That
is the entire argument for this register existing: the criterion for writing an ADR is not "is this
undocumented", it is "would a competent reader independently arrive at the other answer" — and here
one demonstrably did.

## Rejected alternatives

**A per-provider trigger keyed on the capability claim.** Rejected on evidence already in the tree.
It fires wherever the claim is *falsy* — and the claim is an optional field, so **unset is falsy
too**. That is the whole problem: gpt-4o and gpt-4o-mini simply do not declare it, and gpt-4o
**400s on the parameter itself**, so the fix for one model breaks two others by sending them a
parameter they reject. Three OpenRouter seeds are undeclared in the same way, and would receive an
explicit reasoning-off they never asked for.

The trigger cannot distinguish *"this model does not reason"* from *"nobody has said yet."* A claim
used as a mechanism has to treat silence as an answer, and silence is the default state of every
model synthesized from a catalog rather than hand-written.

**A per-provider rule plus an id-based exclusion list to patch that.** Rejected because it is
precisely the shape `provider_quirks.ts:42` was written to forbid. It also gets worse
monotonically: every model that does not fit the provider-wide rule is another id in the list, and
the list is unfalsifiable — nothing fails when a model is missing from it except a live 400.

**Optimistic send, catch the 400, retry.** Rejected because error-string matching across five
providers is brittle, and it mutates behaviour mid-run.

**Withdrawing the per-provider fix outright.** Rejected in MUB-227: it carries OpenRouter's
disable shape and a once-per-session note, both genuinely absent from ours. Binning it loses real
work. The two fixes cover different models and different protocols, and a merged fix wants both
halves — ours is not the superset.

## Consequences

- **A field shipping set on nothing is not a slice.** The per-model off-switch this decision
  requires lands declared and populated on no seed, because populating it needs provider keys, not
  a decision. Under the [horizontal-slice rule](README.md#the-arcs-standing-rule-on-horizontal-slices)
  that makes it inert data rather than a slice: one optional field and one branch, judged on cost.
  It joins the existing modality debt as declared, verifiable-later data.
- **The capability claim stays honest, so routing stays honest.** A reasoning model suppressed on
  one call is still reasoning-capable for ranking. The alternative would have silently changed
  which models the router considers, as a side effect of a wire fix — a routing change nobody
  reviewed as one.
- **Whether tools are present is load-bearing, and belongs to the request, not the model.** The API
  refuses only the tools-plus-effort combination, so a tool-less call — the judge, the classifier,
  an explicitly tool-free run — keeps the model's own default and still reasons. Pinning
  unconditionally would silently downgrade exactly the calls whose quality is hardest to notice.
- **This decision makes a status indicator possible, and MUB-229 is where that is collected.** Once
  "whether to send" is one answer rather than a per-provider accident, the wire and the display can
  read the same function, and the indicator cannot drift from the request. That is a consequence of
  this decision, not an additional feature.
- **The register is now the place this is written down.** The comment at `provider_quirks.ts:69`
  stays — it is correct and it is where an implementer will be — but it is no longer the only copy,
  and it is no longer load-bearing for anyone forming a design.
