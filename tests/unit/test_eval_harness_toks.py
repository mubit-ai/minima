"""Regression guard for the eval harness's near-duplicate primitive.

`_toks`/`_jaccard` back the V1 leakage filter (`_filter_neardup`) and the leaked-neighbor
diagnostic. Both used an ASCII-only token class, which returns the EMPTY set for non-Latin
text; `_jaccard` scores 0.0 whenever either side is empty, so the guard **failed open** — a
verbatim train/test twin written in Tamil would never be dropped, and the leakage diagnostic
would read 0.0 on a corpus that was fully leaked.

Lives in tests/unit (not tests/eval) on purpose: the eval suites are marked `eval` and
deselected by the default CI run, which is exactly how the defect survived.
"""

from __future__ import annotations

from tests.eval.harness import _jaccard, _toks

_TAMIL = "இந்த வாக்கியத்தை ஆங்கிலத்தில் மொழிபெயர்க்கவும்"
_HINDI = "इस लेख का सारांश हिंदी में लिखिए"


def test_toks_is_not_empty_for_non_latin_scripts():
    for text in (_TAMIL, _HINDI, "この段落を要約してください", "لخص هذه الفقرة"):
        assert _toks(text), f"tokenized to the empty set: {text!r}"


def test_neardup_detects_an_identical_non_latin_prompt():
    """The failure that matters: an exact duplicate must score 1.0, not 0.0."""
    assert _jaccard(_toks(_TAMIL), _toks(_TAMIL)) == 1.0


def test_neardup_still_separates_distinct_non_latin_prompts():
    assert _jaccard(_toks(_TAMIL), _toks(_HINDI)) == 0.0


def test_toks_normalizes_compatibility_forms():
    """NFKC so full-width and half-width forms are one token, not two."""
    assert _toks("ＲＥＦＡＣＴＯＲ") == _toks("refactor")


def test_toks_unchanged_on_english():
    assert _toks("Refactor the recursive parser") == {"refactor", "the", "recursive", "parser"}
