"""The classification arms.

Every arm runs the REAL dispatcher (`classify_details`) — no reimplementation of the
tiering. The only thing that varies between arms is what gets passed as `embed`, which is
exactly the seam production uses (`Recommender.__init__(embed_classifier=…)`).

A2 is the important trick: the vocabulary tier lives *inside* `if embed is not None`
(classify.py:563-569) and abstention falls back to the regex, so a stub classifier that
always abstains yields vocabulary→regex through the genuine code path, with no logic
copied out of `src/`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from minima.recommender.classify import classify_details
from minima.recommender.classify_embed import EmbedClassifier, EmbedResult, load_embed_classifier
from minima.schemas.common import TaskInput, TaskType


class StubAbstainClassifier:
    """Always abstains → the dispatcher falls through to the regex, but the vocabulary
    tier still runs. This is arm A2: `vocabulary + regex`, no embedding involved."""

    classifier_id = "stub-abstain"

    def classify(self, text: str, regex_hint: TaskType | None = None) -> EmbedResult:
        return EmbedResult(TaskType.other, 0.0, True)


class NoHintClassifier:
    """The real head with `regex_hint` forced to None (arm A3b).

    For the shipped artifact this is predicted to be a no-op, because `regex_classes` is
    empty and the hint is never consumed — PREREG §0, gate S4.
    """

    def __init__(self, inner: EmbedClassifier):
        self._inner = inner
        self.classifier_id = inner.classifier_id

    def classify(self, text: str, regex_hint: TaskType | None = None) -> EmbedResult:
        return self._inner.classify(text, regex_hint=None)


class DenySetClassifier:
    """The real head, but its verdict is accepted only for classes it is competent at (A6).

    A prediction inside `deny` is converted to an abstain, so the dispatcher falls through to
    the regex (classify.py:574-576) — "route by class competence" expressed entirely through
    the existing seam, with no `src/minima/` change.

    Denies on the PREDICTED class, the only thing available at serving time. That is what lets
    it remove an attractor error (the head labelling `translation` on paraphrase prompts); a
    vocabulary-pattern extension cannot, because those prompts carry no translation vocabulary
    for a pattern to match.
    """

    def __init__(self, inner: EmbedClassifier, deny: frozenset[str]):
        self._inner = inner
        self._deny = deny
        self.classifier_id = inner.classifier_id

    def classify(self, text: str, regex_hint: TaskType | None = None) -> EmbedResult:
        result = self._inner.classify(text, regex_hint=regex_hint)
        if result.abstained or result.task_type.value in self._deny:
            return EmbedResult(TaskType.other, 0.0, True)
        return result


@dataclass(slots=True, frozen=True)
class Prediction:
    task_type: str
    source: str
    abstained: bool | None
    confidence: float


@dataclass(slots=True)
class Arm:
    key: str
    label: str
    embed: object | None
    oracle: bool = False

    def predict(self, text: str, gold: str | None = None) -> Prediction:
        task = TaskInput(task=text, task_type=TaskType(gold) if self.oracle and gold else None)
        est = classify_details(task, embed=self.embed)
        return Prediction(
            task_type=est.task_type.value,
            source=est.profile.task_type_source,
            abstained=est.abstained,
            confidence=est.confidence,
        )


def build_arms(artifact: Path) -> dict[str, Arm]:
    head = load_embed_classifier(str(artifact), required=True)
    assert head is not None
    return {
        "A1": Arm("A1", "regex only", None),
        "A2": Arm("A2", "vocabulary + regex", StubAbstainClassifier()),
        "A3a": Arm("A3a", "vocabulary + head (hint)", head),
        "A3b": Arm("A3b", "vocabulary + head (no hint)", NoHintClassifier(head)),
        "A5": Arm("A5", "gold oracle", head, oracle=True),
    }
