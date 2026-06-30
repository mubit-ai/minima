from __future__ import annotations

import pytest

from minima_harness.tools.apply_patch import (
    ApplyPatchParams,
    PatchError,
    _execute,
    apply_patch_tool,
    parse_patch,
    patch_preview,
    summarize_patch,
)


def _patch(*body: str) -> str:
    return "\n".join(["*** Begin Patch", *body, "*** End Patch"])


async def _run(tmp_path, patch: str):
    import os

    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        return await _execute("c1", ApplyPatchParams(patch=patch), None, None)
    finally:
        os.chdir(cwd)


# --------------------------------------------------------------------------- add


async def test_add_file(tmp_path):
    res = await _run(tmp_path, _patch("*** Add File: new.py", "+a = 1", "+b = 2"))
    assert (tmp_path / "new.py").read_text() == "a = 1\nb = 2\n"
    assert "applied patch" in res.content[0].text


async def test_add_existing_file_errors_and_writes_nothing(tmp_path):
    (tmp_path / "exists.txt").write_text("keep")
    res = await _run(tmp_path, _patch("*** Add File: exists.txt", "+overwrite"))
    assert "already exists" in res.content[0].text
    assert (tmp_path / "exists.txt").read_text() == "keep"


async def test_add_nested_creates_dirs(tmp_path):
    await _run(tmp_path, _patch("*** Add File: pkg/sub/m.py", "+x = 1"))
    assert (tmp_path / "pkg/sub/m.py").read_text() == "x = 1\n"


# --------------------------------------------------------------------------- update


async def test_update_single_hunk(tmp_path):
    f = tmp_path / "f.py"
    f.write_text("def foo():\n    return 1\n")
    await _run(
        tmp_path,
        _patch(
            "*** Update File: f.py",
            "@@ def foo():",
            " def foo():",
            "-    return 1",
            "+    return 2",
        ),
    )
    assert f.read_text() == "def foo():\n    return 2\n"


async def test_update_multiple_hunks_same_file(tmp_path):
    f = tmp_path / "f.py"
    f.write_text("a = 1\nb = 2\nc = 3\nd = 4\n")
    await _run(
        tmp_path,
        _patch(
            "*** Update File: f.py",
            "@@",
            " a = 1",
            "-b = 2",
            "+b = 20",
            "@@",
            " c = 3",
            "-d = 4",
            "+d = 40",
        ),
    )
    assert f.read_text() == "a = 1\nb = 20\nc = 3\nd = 40\n"


async def test_update_preserves_no_trailing_newline(tmp_path):
    f = tmp_path / "f.txt"
    f.write_text("one\ntwo")  # no final newline
    await _run(tmp_path, _patch("*** Update File: f.txt", " one", "-two", "+TWO"))
    assert f.read_text() == "one\nTWO"


async def test_update_fuzzy_whitespace_match(tmp_path):
    # File has trailing whitespace the model didn't reproduce.
    f = tmp_path / "f.py"
    f.write_text("x = 1   \ny = 2\n")
    await _run(tmp_path, _patch("*** Update File: f.py", "-x = 1", "+x = 11", " y = 2"))
    assert f.read_text() == "x = 11\ny = 2\n"


async def test_update_missing_file_errors(tmp_path):
    res = await _run(tmp_path, _patch("*** Update File: nope.py", "-a", "+b"))
    assert "does not exist" in res.content[0].text


async def test_update_unmatched_context_errors_and_no_write(tmp_path):
    f = tmp_path / "f.py"
    f.write_text("real = 1\n")
    res = await _run(tmp_path, _patch("*** Update File: f.py", "-not_here = 9", "+x = 0"))
    assert "could not locate" in res.content[0].text
    assert f.read_text() == "real = 1\n"  # untouched


# --------------------------------------------------------------------------- delete / move


async def test_delete_file(tmp_path):
    f = tmp_path / "gone.txt"
    f.write_text("bye")
    await _run(tmp_path, _patch("*** Delete File: gone.txt"))
    assert not f.exists()


async def test_delete_missing_errors(tmp_path):
    res = await _run(tmp_path, _patch("*** Delete File: ghost.txt"))
    assert "does not exist" in res.content[0].text


async def test_move_renames_and_edits(tmp_path):
    src = tmp_path / "old.py"
    src.write_text("v = 1\n")
    await _run(
        tmp_path,
        _patch(
            "*** Update File: old.py",
            "*** Move to: new.py",
            "-v = 1",
            "+v = 2",
        ),
    )
    assert not src.exists()
    assert (tmp_path / "new.py").read_text() == "v = 2\n"


# --------------------------------------------------------------------------- atomicity


async def test_atomic_across_files(tmp_path):
    # First file's hunk is valid; second is not. Nothing should change.
    a = tmp_path / "a.py"
    b = tmp_path / "b.py"
    a.write_text("a = 1\n")
    b.write_text("b = 1\n")
    res = await _run(
        tmp_path,
        _patch(
            "*** Update File: a.py",
            "-a = 1",
            "+a = 2",
            "*** Update File: b.py",
            "-does_not_match = 9",
            "+b = 2",
        ),
    )
    assert "could not locate" in res.content[0].text
    assert a.read_text() == "a = 1\n"  # rolled back (never written)
    assert b.read_text() == "b = 1\n"


async def test_multi_file_success(tmp_path):
    a = tmp_path / "a.py"
    a.write_text("a = 1\n")
    await _run(
        tmp_path,
        _patch(
            "*** Update File: a.py",
            "-a = 1",
            "+a = 99",
            "*** Add File: b.py",
            "+b = 2",
        ),
    )
    assert a.read_text() == "a = 99\n"
    assert (tmp_path / "b.py").read_text() == "b = 2\n"


# --------------------------------------------------------------------------- parsing


def test_parse_requires_begin():
    with pytest.raises(PatchError, match="Begin Patch"):
        parse_patch("*** Add File: x\n+1\n*** End Patch")


def test_parse_requires_end():
    with pytest.raises(PatchError, match="End Patch"):
        parse_patch("*** Begin Patch\n*** Add File: x\n+1")


def test_parse_counts_changes():
    changes = parse_patch(
        _patch("*** Add File: a", "+1", "*** Delete File: b", "*** Update File: c", "-x", "+y")
    )
    assert [c.kind for c in changes] == ["add", "delete", "update"]


# ----------------------------------------------------------- preview / summary / descriptor


def test_patch_preview_shows_diff(tmp_path):
    (tmp_path / "f.py").write_text("a = 1\n")
    out = patch_preview(_patch("*** Update File: f.py", "-a = 1", "+a = 2"), tmp_path)
    assert "-a = 1" in out and "+a = 2" in out


def test_patch_preview_on_bad_patch_is_safe(tmp_path):
    out = patch_preview("not a patch", tmp_path)
    assert "apply_patch:" in out


def test_summarize_patch():
    s = summarize_patch(_patch("*** Add File: a", "+1", "*** Update File: b", "-x", "+y"))
    assert "2 files" in s
    assert "add    a" in s
    assert "update b" in s


def test_tool_descriptor():
    t = apply_patch_tool()
    assert t.name == "apply_patch"
    assert "*** Begin Patch" in t.description
