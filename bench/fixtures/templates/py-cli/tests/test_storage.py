"""Tests for taskman.storage and taskman.migrations."""

import json
from datetime import date

import pytest

from taskman.migrations import CURRENT_SCHEMA, MigrationError, migrate
from taskman.storage import StorageError, Store

from .conftest import make_task


def write_json(path, doc):
    path.write_text(json.dumps(doc), encoding="utf-8")


def test_load_missing_file_is_empty(store_path):
    assert Store(store_path).load() == []


def test_save_load_roundtrip(store_path):
    store = Store(store_path)
    tasks = [
        make_task(id=1, title="Buy milk", priority=1, tags=("home",), due=date(2026, 4, 1)),
        make_task(id=2, title="File taxes", priority=3, status="done"),
    ]
    store.save(tasks)
    assert store.load() == tasks


def test_save_writes_current_schema(store_path):
    store = Store(store_path)
    store.save([make_task()])
    doc = json.loads(store_path.read_text(encoding="utf-8"))
    assert doc["schema"] == CURRENT_SCHEMA
    assert isinstance(doc["tasks"], list)


def test_load_rejects_invalid_json(store_path):
    store_path.write_text("{not json", encoding="utf-8")
    with pytest.raises(StorageError):
        Store(store_path).load()


def test_load_rejects_unknown_schema(store_path):
    write_json(store_path, {"schema": 99, "tasks": []})
    with pytest.raises(StorageError):
        Store(store_path).load()
    write_json(store_path, {"tasks": []})
    with pytest.raises(StorageError):
        Store(store_path).load()


def test_migrate_noop_and_bad_markers():
    doc = {"schema": CURRENT_SCHEMA, "tasks": []}
    assert migrate(doc) is doc
    with pytest.raises(MigrationError):
        migrate({"schema": "three", "tasks": []})
    with pytest.raises(MigrationError):
        migrate({"schema": 0, "tasks": []})


def test_v1_file_loads_with_converted_fields(store_path):
    """v1 files stored priority labels and comma-joined tag strings."""
    write_json(
        store_path,
        {
            "schema": 1,
            "tasks": [
                {
                    "id": 1,
                    "title": "Renew passport",
                    "priority": "high",
                    "tags": "Admin, Urgent",
                    "due": None,
                    "done": False,
                    "created": "2025-11-02",
                },
                {
                    "id": 2,
                    "title": "Old errand",
                    "priority": "low",
                    "tags": "",
                    "due": None,
                    "done": True,
                    "created": "2025-10-01",
                },
            ],
        },
    )
    tasks = Store(store_path).load()
    assert [t.id for t in tasks] == [1, 2]
    assert tasks[0].priority == 1
    assert tasks[0].tags == ["admin", "urgent"]
    assert tasks[0].status == "open"
    assert tasks[0].created == date(2025, 11, 2)
    assert tasks[1].priority == 3
    assert tasks[1].status == "done"


def test_v2_file_loads_with_status_and_due(store_path):
    """v2 files kept the boolean done flag; everything else was modern."""
    write_json(
        store_path,
        {
            "schema": 2,
            "tasks": [
                {
                    "id": 5,
                    "title": "Book dentist",
                    "priority": 2,
                    "tags": ["health"],
                    "due": "2026-04-20",
                    "done": False,
                    "created": "2026-01-05",
                },
                {
                    "id": 6,
                    "title": "Archive photos",
                    "priority": 3,
                    "tags": [],
                    "due": None,
                    "done": True,
                    "created": "2026-01-06",
                },
            ],
        },
    )
    tasks = Store(store_path).load()
    assert tasks[0].due == date(2026, 4, 20)
    assert tasks[0].status == "open"
    assert tasks[1].status == "done"
    assert tasks[1].due is None


def test_next_id_find_and_remove(store_path):
    store = Store(store_path)
    assert store.next_id([]) == 1
    assert store.next_id([make_task(id=1), make_task(id=7)]) == 8
    tasks = [make_task(id=1), make_task(id=2)]
    assert store.find(tasks, 2).id == 2
    with pytest.raises(StorageError):
        store.find(tasks, 99)
    remaining = store.remove(tasks, 1)
    assert [t.id for t in remaining] == [2]
    with pytest.raises(StorageError):
        store.remove(tasks, 99)
