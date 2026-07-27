"""FROZEN gold-label map: SNI's 76 task categories -> Minima's 11 TaskType values.

This file is the weakest link in the whole evaluation — the gold labels are our reading of
SNI's category semantics, not a labeled resource. It is therefore committed BEFORE any arm
is run (hash recorded in PREREG.md and in the report), and results are reported per
category so anyone can re-aggregate under a different map.

Authoring rules, applied to SNI's own `Definition` text rather than the category NAME
(the names are unreliable: `Text to Code` contains a yes/no classification task, `Pos
Tagging` contains "write an implausible tag"):

  R1  The label is the task's OUTPUT SHAPE, which is what Minima's taxonomy encodes:
      pick-a-label -> classification, produce-new-prose -> creative, pull-spans-from-input
      -> extraction, condense -> summarization, answer-a-question -> qa,
      derive-through-steps -> reasoning, cross-language -> translation.
  R2  Minima's own documented adjudications are followed verbatim (scripts/classifier/
      seeds.py header): rewrite/draft -> creative, explanation-imperative -> qa,
      comparison/advice analysis -> reasoning.
  R3  A category whose member tasks DISAGREE on output shape is UNMAPPABLE, not guessed.
      Unmappable rows are excluded from accuracy and scored only for abstention behavior.
  R4  `other` is never assigned. In Minima it means unpriceable/out-of-scope; every SNI
      task is a real priced task, so mapping any of them to `other` would manufacture a
      sink. Rows the arms send to `other` are therefore always errors here — symmetric
      across arms, and reported separately as sink-leakage.

Coverage consequence, stated plainly: SNI yields NO reliable `code`, `rag`, `tool_use`, or
`other` gold. Conclusions below are valid for the 7 covered types only.
"""

from __future__ import annotations

# --- mapped ---------------------------------------------------------------------------

CATEGORY_MAP: dict[str, str] = {
    # cross-language, definitionally consistent
    "Translation": "translation",
    # answer a question / supply the explanation asked for (R2)
    "Question Answering": "qa",
    "Explanation": "qa",
    # emit one of a fixed label set
    "Sentiment Analysis": "classification",
    "Text Categorization": "classification",
    "Text Matching": "classification",
    "Toxic Language Detection": "classification",
    "Cause Effect Classification": "classification",
    "Textual Entailment": "classification",
    "Commonsense Classification": "classification",
    "Answerability Classification": "classification",
    "Language Identification": "classification",
    "Question Understanding": "classification",
    "Linguistic Probing": "classification",
    "Word Semantics": "classification",
    "Text Quality Evaluation": "classification",
    "Answer Verification": "classification",
    "Negotiation Strategy Detection": "classification",
    "Dialogue Act Recognition": "classification",
    "Gender Classification": "classification",
    "Stereotype Detection": "classification",
    "Coherence Classification": "classification",
    "Ethics Classification": "classification",
    "Intent Identification": "classification",
    "Stance Detection": "classification",
    "Fact Verification": "classification",
    "Section Classification": "classification",
    "Irony Detection": "classification",
    "Spam Classification": "classification",
    "Grammar Error Detection": "classification",
    "Spelling Error Detection": "classification",
    "Punctuation Error Detection": "classification",
    "Word Relation Classification": "classification",
    "Speaker Relation Classification": "classification",
    "Discourse Relation Classification": "classification",
    "Entity Relation Classification": "classification",
    # pull spans that are strictly present in the input
    "Information Extraction": "extraction",
    "Named Entity Recognition": "extraction",
    "Keyword Tagging": "extraction",
    "Overlap Extraction": "extraction",
    "Speaker Identification": "extraction",
    "Coreference Resolution": "extraction",
    "Discourse Connective Identification": "extraction",
    # condense
    "Summarization": "summarization",
    "Title Generation": "summarization",
    "Sentence Compression": "summarization",
    # produce new prose, incl. rewrite/draft/perturb (R2)
    "Question Generation": "creative",
    "Wrong Candidate Generation": "creative",
    "Sentence Composition": "creative",
    "Sentence Perturbation": "creative",
    "Dialogue Generation": "creative",
    "Paraphrasing": "creative",
    "Question Rewriting": "creative",
    "Data to Text": "creative",
    "Story Composition": "creative",
    "Text Simplification": "creative",
    "Style Transfer": "creative",
    "Grammar Error Correction": "creative",
    "Sentence Expansion": "creative",
    "Entity Generation": "creative",
    "Poem Generation": "creative",
    # derive an answer through stated steps
    "Program Execution": "reasoning",
    "Mathematics": "reasoning",
    "Word Analogy": "reasoning",
    "Sentence Ordering": "reasoning",
    "Question Decomposition": "reasoning",
    "Number Conversion": "reasoning",
}

# --- unmappable (R3) — excluded from accuracy, kept for abstention analysis ------------

UNMAPPABLE: dict[str, str] = {
    "Misc.": "grab-bag; member tasks span conversion, inference, and generation",
    "Text to Code": "members include a yes/no label task (task211_logic2text_classification)",
    "Code to Text": "members are command generation, not code explanation",
    "Fill in The Blank": "splits between free generation and multiple-choice selection",
    "Text Completion": "splits between continuation and style classification",
    "Pos Tagging": "splits between tag generation and 'write an implausible tag'",
    "Dialogue State Tracking": "splits between slot answering and deal yes/no classification",
    "Preposition Prediction": "single task, fill-in shape ambiguous",
    "Paper Review": "single task, shape ambiguous",
}

# Categories deemed most contestable. The report re-runs the primary endpoint with these
# dropped, so a reader can see whether the verdict depends on our judgment calls.
CONTESTABLE = (
    "Program Execution",
    "Question Generation",
    "Wrong Candidate Generation",
    "Coreference Resolution",
    "Text Matching",
    "Linguistic Probing",
)


def label_for(category: str) -> str | None:
    return CATEGORY_MAP.get(category)


def coverage() -> dict[str, int]:
    out: dict[str, int] = {}
    for v in CATEGORY_MAP.values():
        out[v] = out.get(v, 0) + 1
    return out
