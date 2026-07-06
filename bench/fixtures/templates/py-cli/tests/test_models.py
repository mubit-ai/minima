"""Tests for taskman.models — Task invariants and (de)serialisation."""

from datetime import date

import pytest

from taskman.models import (
    Task,
    TaskValidationError,
    normalize_tags,
    parse_priority,
    priority_label,
    split_tag_string,
)

from .conftest import make_task


def test_valid_construction():
    task = make_task(id=7, title="Ship release", priority=1, tags=("Work", "release"))
    assert task.id == 7
    assert task.title == "Ship release"
    assert task.priority == 1
    assert task.tags == ["work", "release"]
    assert task.status == "open"
    assert not task.is_done


def test_title_is_stripped_and_required():
    assert make_task(title="  padded  ").title == "padded"
    with pytest.raises(TaskValidationError):
        make_task(title="   ")


def test_field_invariants_rejected():
    with pytest.raises(TaskValidationError):
        make_task(id=0)
    with pytest.raises(TaskValidationError):
        make_task(id=-3)
    with pytest.raises(TaskValidationError):
        make_task(priority=0)
    with pytest.raises(TaskValidationError):
        make_task(priority=4)
    with pytest.raises(TaskValidationError):
        make_task(status="archived")


def test_tag_normalisation():
    raw = ["  Home ", "ERRAND", "home", "", "  ", "garden"]
    assert normalize_tags(raw) == ["home", "errand", "garden"]
    assert split_tag_string("Home, errand,,HOME , yard") == ["home", "errand", "yard"]
    assert split_tag_string("") == []


def test_parse_priority_accepts_labels_and_digits():
    assert parse_priority("high") == 1
    assert parse_priority(" LOW ") == 3
    assert parse_priority("2") == 2
    with pytest.raises(TaskValidationError):
        parse_priority("urgent")
    with pytest.raises(TaskValidationError):
        parse_priority("5")


def test_priority_labels():
    assert priority_label(1) == "high"
    assert priority_label(3) == "low"
    assert make_task(priority=1).priority_name == "high"
    with pytest.raises(TaskValidationError):
        priority_label(9)


def test_mark_done_and_reopen():
    task = make_task()
    task.mark_done()
    assert task.is_done and task.status == "done"
    task.mark_done()  # idempotent
    assert task.is_done
    task.reopen()
    assert not task.is_done and task.status == "open"


def test_has_tag_case_insensitive():
    task = make_task(tags=("home", "errand"))
    assert task.has_tag("HOME")
    assert task.has_tag(" errand ")
    assert not task.has_tag("work")


def test_to_dict_from_dict_roundtrip():
    task = make_task(
        id=4,
        title="Water plants",
        priority=3,
        tags=("garden",),
        due=date(2026, 4, 1),
        created=date(2026, 3, 2),
    )
    raw = task.to_dict()
    assert raw["due"] == "2026-04-01"
    assert raw["created"] == "2026-03-02"
    clone = Task.from_dict(raw)
    assert clone == task


def test_from_dict_ignores_unknown_keys():
    raw = {
        "id": 2,
        "title": "Read book",
        "priority": 3,
        "tags": ["leisure"],
        "due": None,
        "status": "open",
        "created": "2026-03-01",
        "colour": "blue",
        "legacy_flag": True,
    }
    task = Task.from_dict(raw)
    assert task.title == "Read book"
    assert task.due is None
