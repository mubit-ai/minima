"""Classifier program PR-8: the committed production artifact (the one the Docker image
bakes) stays loadable and id-honest. The id is derived from the bundle bytes, so a
hand-edited artifact under an unbumped directory name fails here before it ships.

ARTIFACT.name is the single intended-id pin: the content-hash test proves the bytes
match it, the Dockerfile-sync test proves the deploy points at it, and a re-train that
bumps the hash fails all three until this literal (and the Dockerfile) are updated."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from minima.recommender.classify import classify_details
from minima.recommender.classify_embed import load_embed_classifier
from minima.schemas.common import TaskInput, TaskType

_ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = _ROOT / "models" / "classifier" / "potion-base-32M-c18e819c6c6d"


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


def test_dockerfile_artifact_path_matches_committed_dir():
    # The image sets MINIMA_CLASSIFIER_ARTIFACT to a hardcoded path; a re-train bumps the
    # dir name, and with MINIMA_CLASSIFIER_REQUIRED=1 in staging/prod a stale path is a
    # fail-loud startup crash. Turn that into a red PR: the Dockerfile must track ARTIFACT.
    dockerfile = (_ROOT / "Dockerfile").read_text()
    m = re.search(r'MINIMA_CLASSIFIER_ARTIFACT="[^"]*/classifier/([^"/]+)"', dockerfile)
    assert m, "MINIMA_CLASSIFIER_ARTIFACT=.../classifier/<id> not found in Dockerfile"
    assert m.group(1) == ARTIFACT.name


def test_engine_serves_task_type_from_committed_head():
    # End-to-end through classify_details: a confident embed label wins and is sourced as
    # "embedding" (not the regex), which is what the recommender routes on.
    clf = load_embed_classifier(str(ARTIFACT), required=True)
    details = classify_details(TaskInput(task="Refactor the auth module and add tests"), embed=clf)
    assert details.task_type is TaskType.code
    assert details.profile.task_type_source == "embedding"
