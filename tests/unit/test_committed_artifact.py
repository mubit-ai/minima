"""Classifier program PR-8: the committed production artifact (the one the Docker image
bakes) stays loadable and id-honest. The id is derived from the bundle bytes, so a
hand-edited artifact under an unbumped directory name fails here before it ships."""

from __future__ import annotations

import hashlib
from pathlib import Path

from minima.recommender.classify_embed import load_embed_classifier
from minima.schemas.common import TaskType

ARTIFACT = (
    Path(__file__).resolve().parents[2] / "models" / "classifier" / "potion-base-32M-c18e819c6c6d"
)


def test_artifact_directory_name_matches_content_hash():
    h = hashlib.sha256()
    for f in sorted(p for p in ARTIFACT.iterdir() if p.name != "manifest.json"):
        h.update(f.name.encode())
        h.update(f.read_bytes())
    assert ARTIFACT.name == f"potion-base-32M-{h.hexdigest()[:12]}"


def test_artifact_loads_and_classifies_into_the_enum():
    clf = load_embed_classifier(str(ARTIFACT), required=True)
    assert clf is not None
    assert clf.classifier_id == ARTIFACT.name
    res = clf.classify("write a python function that reverses a linked list")
    assert res.task_type in set(TaskType)
    assert res.abstained in (True, False)
