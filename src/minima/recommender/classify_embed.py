"""Static-embedding task classifier (classifier program PR-5).

Loads the artifact bundle produced by scripts/classifier/train.py (embeddings.npz int8
+ head.npz + tokenizer.json + manifest.json) and classifies task text with a numpy
matmul over frozen potion embeddings — sub-millisecond, no torch, no network. The
``[classifier]`` extra (numpy + tokenizers) is the only dependency; without it, or
without an artifact, the recommender runs the regex heuristic exactly as before
(``minima_classifier_required`` makes that degradation fail-loud instead).

Abstention is kNN-distance-to-anchors + top-2 margin with thresholds fit conformally at
train time — an abstain falls through to the regex, so ``other`` stays a priced decision
and the unpriced-sink failure cannot return wearing an embedding.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from minima.schemas.common import TaskType

_MAX_CLASSIFY_CHARS = 4096


class ClassifierUnavailable(RuntimeError):
    """The embed classifier was requested but cannot run (missing extra or artifact)."""


@dataclass(slots=True, frozen=True)
class EmbedResult:
    task_type: TaskType
    confidence: float
    abstained: bool


class EmbedClassifier:
    def __init__(self, artifact_dir: Path):
        try:
            import numpy as np
            from tokenizers import Tokenizer
        except ImportError as exc:  # pragma: no cover - exercised via load_embed_classifier
            raise ClassifierUnavailable(
                "the [classifier] extra is not installed (pip install 'minima-cli[classifier]')"
            ) from exc
        self._np = np
        emb = np.load(artifact_dir / "embeddings.npz")
        self._embeddings = emb["q"].astype(np.float32) * emb["scales"][:, None]
        head = np.load(artifact_dir / "head.npz", allow_pickle=False)
        self._coef = head["coef"].astype(np.float32)
        self._intercept = head["intercept"].astype(np.float32)
        self._anchors = head["anchors"].astype(np.float32)
        self._tau_dist = float(head["tau_dist"])
        self._tau_margin = float(head["tau_margin"])
        classes = [str(c) for c in head["classes"]]
        valid = {t.value for t in TaskType}
        unknown = [c for c in classes if c not in valid]
        if unknown:
            raise ClassifierUnavailable(f"artifact classes not in the TaskType enum: {unknown}")
        self._classes = [TaskType(c) for c in classes]
        regex_classes = [str(c) for c in head["regex_classes"]] if "regex_classes" in head else []
        if regex_classes and any(c not in valid for c in regex_classes):
            raise ClassifierUnavailable("artifact regex-feature classes not in the TaskType enum")
        self._regex_classes = regex_classes
        self._regex_scale = float(head["regex_scale"]) if "regex_scale" in head else 1.0
        self._tokenizer = Tokenizer.from_file(str(artifact_dir / "tokenizer.json"))
        manifest = json.loads((artifact_dir / "manifest.json").read_text())
        self.classifier_id = str(manifest["classifier_id"])

    def classify(self, text: str, regex_hint: TaskType | None = None) -> EmbedResult:
        np = self._np
        ids = self._tokenizer.encode(text[:_MAX_CLASSIFY_CHARS], add_special_tokens=False).ids
        if not ids:
            return EmbedResult(TaskType.other, 0.0, True)
        v = self._embeddings[ids].mean(axis=0)
        norm = float(np.linalg.norm(v))
        if norm <= 0.0:
            return EmbedResult(TaskType.other, 0.0, True)
        v = v / norm
        if self._regex_classes:
            onehot = np.zeros(len(self._regex_classes), dtype=np.float32)
            if regex_hint is not None and regex_hint.value in self._regex_classes:
                onehot[self._regex_classes.index(regex_hint.value)] = self._regex_scale
            feats = np.concatenate([v, onehot])
        else:
            feats = v
        logits = self._coef @ feats + self._intercept
        p = np.exp(logits - logits.max())
        p /= p.sum()
        order = np.argsort(p)
        top = int(order[-1])
        margin = float(p[order[-1]] - p[order[-2]])
        dist = 1.0 - float((self._anchors @ v).max())
        abstained = dist > self._tau_dist or margin < self._tau_margin
        return EmbedResult(self._classes[top], float(p[top]), abstained)


def load_embed_classifier(
    artifact_path: str, *, required: bool
) -> EmbedClassifier | None:
    """Load the artifact, honoring the fail-loud contract: with ``required`` the deploy
    refuses to start on ANY load problem; without it every problem degrades to the regex
    (returns None) with the reason surfaced by the caller's log."""
    try:
        path = Path(artifact_path)
        if not artifact_path or not path.is_dir():
            raise ClassifierUnavailable(f"classifier artifact not found at {artifact_path!r}")
        return EmbedClassifier(path)
    except Exception as exc:
        if required:
            raise ClassifierUnavailable(
                f"minima_classifier_required is set but the classifier cannot load: {exc}"
            ) from exc
        return None
