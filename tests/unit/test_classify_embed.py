"""Classifier program PR-5: the embed classifier and its dispatcher contract — caller
override wins and skips the head entirely, abstention falls through to the regex, the
profile's heuristic_* fields always keep the regex's own opinion, and load failures obey
the fail-loud setting."""

from __future__ import annotations

import pytest

from minima.recommender.classify import CLASSIFIER_ID, classify_details
from minima.recommender.classify_embed import (
    ClassifierUnavailable,
    EmbedClassifier,
    load_embed_classifier,
)
from minima.schemas.common import TaskInput, TaskType
from tests.factories import make_classifier_artifact


@pytest.fixture(scope="module")
def artifact(tmp_path_factory):
    return make_classifier_artifact(tmp_path_factory.mktemp("clf"))


@pytest.fixture(scope="module")
def embed(artifact):
    return EmbedClassifier(artifact)


def test_fixture_classifies_and_abstains(embed):
    assert embed.classifier_id == "fixture-classifier-0001"
    confident = embed.classify("fix the def bug")
    assert confident.task_type == TaskType.code and not confident.abstained
    creative = embed.classify("write a poem story")
    assert creative.task_type == TaskType.creative and not creative.abstained
    unknown = embed.classify("zzz totally unknown words")
    assert unknown.abstained


def test_dispatch_embedding_assigns_and_regex_opinion_survives(embed):
    est = classify_details(TaskInput(task="write a poem story"), embed=embed)
    assert est.task_type == TaskType.creative
    assert est.profile.task_type_source == "embedding"
    assert est.classifier_id == "fixture-classifier-0001"
    assert est.abstained is False
    # The regex's OWN opinion stays in heuristic_* — the agreement-telemetry contract.
    from minima.recommender.classify import infer_task_type

    assert est.profile.heuristic_task_type == infer_task_type("write a poem story")


def test_dispatch_abstain_falls_through_to_regex(embed):
    est = classify_details(
        TaskInput(task="zzz unknown vocabulary asks to refactor stats.py"), embed=embed
    )
    assert est.profile.task_type_source == "embedding_abstain"
    assert est.abstained is True
    assert est.task_type == est.profile.heuristic_task_type  # regex assigned the label
    assert est.classifier_id == "fixture-classifier-0001"  # deployment id, not the path


def test_caller_override_skips_the_head(artifact):
    calls = []

    class Spy(EmbedClassifier):
        def classify(self, text):
            calls.append(text)
            return super().classify(text)

    est = classify_details(
        TaskInput(task="write a poem story", task_type=TaskType.code), embed=Spy(artifact)
    )
    assert est.task_type == TaskType.code
    assert est.profile.task_type_source == "caller"
    assert calls == []


def test_no_embed_is_byte_identical_regex(embed):
    with_none = classify_details(TaskInput(task="fix the bug in stats.py"))
    assert with_none.profile.task_type_source == "heuristic"
    assert with_none.classifier_id == CLASSIFIER_ID
    assert with_none.abstained is None


def test_load_missing_artifact_fails_open_or_loud(tmp_path):
    assert load_embed_classifier(str(tmp_path / "nope"), required=False) is None
    with pytest.raises(ClassifierUnavailable):
        load_embed_classifier(str(tmp_path / "nope"), required=True)


def test_load_rejects_unknown_class_names(tmp_path):
    import numpy as np

    path = make_classifier_artifact(tmp_path)
    head = dict(np.load(path / "head.npz", allow_pickle=False))
    head["classes"] = np.array(["code", "poetry", "other"])
    np.savez_compressed(path / "head.npz", **head)
    assert load_embed_classifier(str(path), required=False) is None
    with pytest.raises(ClassifierUnavailable):
        load_embed_classifier(str(path), required=True)
