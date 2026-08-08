# Architecture decision records

One file per decision that a later reader would otherwise undo. An ADR earns its place when the
decision is **surprising** — when the obvious reading of the code, or the convention every
comparable tool follows, points the other way. A decision nobody would think to reverse does not
need a record; it needs a comment.

Each record states the decision, why it is surprising, and the alternative that was rejected. The
rejected alternative is not a courtesy: it is the half a reader reconstructs wrongly when it is
missing, and re-litigates six weeks later.

## Numbering

This register starts at **0020**. Numbers below that are spoken for by the confidence arc, which
is unlanded across several branches and reaches **0010** on its integration branch. The Tier 1
(revised) arc leaves the whole range clear rather than the 0001–0007 the planning ticket assumed,
because that count came from one branch of several and was already stale when it was written.

Two unlanded registers cannot see each other. If a third arc starts before either lands, check
every branch that carries this directory, not just the one nearest to hand.

## The arc's standing rule on horizontal slices

Stated once, here, for the whole arc — this call came up four separate times during planning and
was re-argued each time:

> A horizontal slice is allowed when its consumer is a ticket on this board. Forbidden when the
> consumer is external or blocked. Inert data nothing reads isn't a slice at all — judge it on
> cost, like docs.

The three cases are genuinely different and the middle one is the trap. A slice whose consumer is
a ticket on this board is ordinary sequencing: the consumer is coming, the schedule is ours, and
building the producer first is a choice about order. A slice whose consumer is someone else's open
PR, or a ticket that is blocked, is not sequencing — it is a bet on a conversation that has not
happened, and if the bet loses, the slice is dead code that someone must now argue about removing.

The third case is the one that looks like the second and is not. Inert data — a declared field set
on nothing, a flag no branch reads — is not a slice, because nothing depends on the order it lands
in. It has a cost and no risk, so it is judged the way documentation is judged: is it worth the
lines? Two decisions in this register turn on that distinction, and both come out differently from
how a blanket "no speculative work" rule would have decided them.

## Records

| # | decision | status |
| -- | -- | -- |
| [0020](0020-project-config-safer-side-clamp.md) | A committed project config may only move a value toward the safer side | accepted |
| [0021](0021-reasoning-capability-is-registry-data.md) | Reasoning capability is registry data, never a per-provider rule | accepted |
| [0022](0022-project-sourced-content-lands-pending.md) | Project-sourced content lands `pending` on a fresh clone | **deferred — not written** |
