# 0001 — The consensus-label cache is a ledger table of individual votes

- Status: accepted
- Date: 2026-07-30
- Written by: MUB-216 · read by MUB-218 and MUB-226

## Context

MUB-216 pays a reference panel to label the classifier-evaluation corpus. Those labels are the
first persistent state in the measurement arc, and they come into existence as a side effect of a
ticket whose real job is paying for them — so until their shape is fixed, MUB-218 and MUB-226
cannot be written against fixtures at all. This records the contract they may rely on; it does not
implement it.

## Decision

**A `MinimaDb` table, not a JSON file.** The corpus is the owner's own development traffic. It must
not be dumped to a file, and the ledger already holds it legitimately, so keeping the labels there
adds no new place that traffic lives. Precedent: `observer_verdicts` / `observer_events`
(`minima_db.ts:400-425`) — durable rows beside an append-only event trail, added as one appended
migration batch.

**Keyed by the sha256 of the exact prompt text; store the hash, never the text.** The corpus is
distinct prompts (`DistinctPrompt {text, occurrences}`), collapsed on exact recorded text. Keying on
a ledger row id instead would write one prompt to several rows and let identical text carry
inconsistent labels — the corpus's own unit of work is the text, so the key has to be too.

**One row per `(prompt_hash, model_id)` — the individual vote. Consensus is derived at read time,
never stored.** MUB-226 adjudicates overrides and MUB-218 builds a reliability curve, and either may
need to tell a unanimous panel from a 2-1 split. A stored verdict discards that, and recovering it
afterwards costs another paid run.

**A `corpus_rev` column, sourced from a constant the eval core exports, bumped whenever the steer
predicate changes.** That predicate decides what counts as a prompt at all (see
[0002](0002-harness-steer-text-predicate.md)), so a change to it makes the corpus a different set.
A revision column turns that into a cache miss rather than labels quietly attributed to a corpus
that no longer exists.

## Consequences

- Labels survive across runs, so MUB-218 and MUB-226 become testable against fixtures, and only a
  `corpus_rev` bump or a new panel member costs money again.
- The hash is one-way by construction, so a cached label cannot be walked back to its prompt.
  Prompt-level error analysis must re-derive hashes from the live corpus, and a label whose prompt
  has left the ledger is unreadable. Accepted: that is the cost of not storing the text, and the
  reason the corpus is retained rather than the labels alone.
- Consensus as a read-time function means the quorum rule can change without a migration — and
  every consumer must go through that one function instead of writing its own.

## Migration version

Append the batch; never insert it, and do not hard-code a version number in its comment. The
version is the batch's array index: `MIGRATIONS.length` is 22 (verified on both this branch and
`feat/classifier-eval-spend-gate` at `67195cf`, whose `minima_db.ts` differs from this one only by
MUB-215's `listUserPrompts`), so the next appended batch is v23.

`v19` at `minima_db.ts:445` is the highest *numbered* comment, but it is not the highest version:
five shipped batches carry no number at all — v15, v16, v20, v21 and v22. Those are the batches
authored on unmerged branches, and their own comments say why ("batch position may shift at rebase
… renumber unmerged, never edit shipped"). MUB-216's batch is in exactly that position, so it
follows the same convention: describe the batch, note that its index may shift, and leave the
number to whatever it lands at. A comment claiming v20 would name an already-shipped batch.
