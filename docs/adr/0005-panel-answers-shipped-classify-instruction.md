# 0005 — The reference panel answers the shipped classify instruction, verbatim

- Status: accepted
- Date: 2026-07-30
- Written by: MUB-216 · read by MUB-218

## Context

MUB-216 pays three strong models to label the evaluation corpus, and MUB-218 scores the shipped
classifier against those labels. What instruction the panelists are given decides what a measured
gap between the two can be attributed to.

## Decision

Panelists receive `CLASSIFY_SYSTEM` verbatim and their replies go through `parseClassification` —
both imported from `classify.ts` by `makePanelCaller` rather than restated (`consensus_panel.ts`,
`23fc234`). The panel is a strictly-stronger-models replay of the exact call under test: same
instruction, same parser, different models.

Two departures, both operational rather than instructional. No session-context size hint is sent,
because the corpus is prompts rather than sessions and MUB-218's replay will have none either — the
two stay comparable. And the panel sets `max_tokens`, so unlike `classify.ts` it can reach a
`length` stop and must treat one as retryable (`23f197d`).

## Rejected alternative

A bespoke reference instruction — a fuller labelling prompt with per-task-type definitions and
tie-break guidance. It would likely have raised unanimity. But then part of any
classifier-versus-panel gap is prompt difference rather than model capability, and MUB-218 has no
way to separate the two from a single run: a stronger model answering a better question is not a
measurement of the model.

Two further properties come from sharing the shipped call rather than authoring a second one. A
reply that will not parse means the same thing on both sides, because it is the same parser. And the
99-token fixed input overhead the cost model charges every call (`LABEL_INSTRUCTION_TOKENS` in
`classifier_eval.ts`, consumed by `panelCallSpecs`) is literally the instruction both sides send,
rather than an average over two different ones.

## Consequences

- The headline **unanimity of 181/237 (76.4%)** over complete panels is unanimity UNDER THE SHIPPED
  INSTRUCTION. That is exactly the right reference for MUB-218's comparison — it is the question the
  shipped classifier is asked. It is NOT evidence about the taxonomy in the abstract, and must not
  be quoted as though it were.
- The disagreements concentrate on three types: `code` vs `tool_use` (12), `code` vs `other` (10),
  `other` vs `tool_use` (10) (`23fc234`). A fuller instruction with explicit definitions might
  separate those cleanly. This run cannot tell whether it would.
- So "the taxonomy is bad" and "the instruction is thin" are not distinguishable from these labels.
  The panel readout states the ambiguity in the caveats it prints with every figure; it cannot
  resolve it.

## Future work

Separating the two takes a second panel run at a different instruction over the same corpus, read
against this one — a new ticket and another few dollars of panel spend. Note for whoever writes it
that a new instruction is not a `corpus_rev` bump under
[0001](0001-consensus-label-cache.md): the corpus is unchanged, so the second run's votes would
collide with these on `(prompt_hash, model_id)` and need a key of their own.
