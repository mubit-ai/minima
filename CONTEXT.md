# Context

The project glossary: canonical names for terms this codebase would otherwise overload.

Each entry names the quantity, who produces it, and what it ranges over. Definitions here carry
no paths, code or configuration on purpose — they say what a term *means*, not where it lives, so
they stay true as the code moves. Architectural orientation lives elsewhere; this file fixes what
the words mean.

One section per overloaded term. Add a section when a term turns out to be doing more than one
job.

## "Confidence"

Eight distinct quantities have been called "confidence" here. They share a word and nothing else:
different producers, different ranges, and — the part that matters — different trustworthiness.
Each has a canonical name below. Use it; never the bare word.

### Produced by the recommendation service

**Route confidence** — the service's confidence in the model ranking it returned for a request;
continuous, 0 to 1.

**Classification confidence** — the service's confidence in the task type it settled on for a
request; continuous, 0 to 1.

> Its provenance is not fixed. When a trained embedding classifier is loaded this carries that
> classifier's own probability; otherwise it carries a hand-tuned score derived from a heuristic
> uncertainty estimate. Two unlike numbers wear one name, so the provenance is part of the value:
> plotted over time this draws two different quantities on one line, and reporting it without
> saying which classifier produced it is not meaningful.

### Produced by the harness

**Label self-report** — the harness classifier model's asserted certainty about its own output,
covering its task-type and difficulty labels jointly; continuous, 0 to 1.

**Verification tier** — harness code's verdict on a plan step, computed from the provenance of
that step's evidence; ordinal — red, yellow, or green — and never a number.

### Produced by Mubit

**Knowledge confidence** — Mubit's certainty in a single recalled memory entry, attached per
entry; continuous, 0 to 1.

**Reinforced confidence** — Mubit's revised certainty for a memory entry after a feedback write
updated it; continuous, 0 to 1.

**Stored-object confidence** — Mubit's certainty in a curated object it holds, such as a failure
lesson or an emergent strategy, including averages reported across a group of them; continuous,
0 to 1.

### Not yet produced by anything

**Label token probability** — the probability the serving model's own output distribution assigned
to the token carrying a label; continuous, 0 to 1. Proposed; nothing emits it today.

### Trustworthiness

The ordering matters more than any of the numbers.

- **Verification tier** is the only one grounded in falsifiable evidence rather than an opinion,
  which is why it alone may label an outcome verified.
- **Label token probability** would be measured *from* a model instead of asserted *by* one —
  weaker than evidence, stronger than a claim.
- **Route confidence**, **classification confidence**, **knowledge confidence**, **reinforced
  confidence** and **stored-object confidence** are computed, but from priors and past outcomes
  rather than from how the current task actually turned out.
- **Label self-report** is the weakest: a model's claim about itself, with nothing checking it.

Every one of these is weak supervision. **None of them may become evidence that an outcome
occurred.**

### The naming rule

A new quantity does not get called "confidence". It gets a name saying what it is confident about
and who produced it, and an entry above in the same shape: producer, range, one line.
