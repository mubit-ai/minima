from __future__ import annotations

from minima_harness.tools._io import read_lines, truncate_line, write_text


def test_truncate_line_keeps_short_lines():
    assert truncate_line("x" * 100) == "x" * 100


def test_truncate_line_cuts_long_lines():
    out = truncate_line("x" * 3000)
    assert out.startswith("x" * 2000)
    assert out.endswith("…(truncated)")
    assert len(out) < 3000


def test_read_lines_returns_numbered(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("one\ntwo\nthree\n")
    body, n = read_lines(f, offset=1, limit=2000)
    assert n == 3
    assert "1: one" in body and "3: three" in body


def test_read_lines_offset_and_limit(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("a\nb\nc\nd\ne\n")
    body, n = read_lines(f, offset=2, limit=2)
    assert n == 2
    assert "2: b" in body and "3: c" in body
    assert "a" not in body.splitlines()[0]


def test_write_text_creates_parents_and_counts_lines(tmp_path):
    f = tmp_path / "nested" / "out.txt"
    n = write_text(f, "a\nb\nc\n")
    assert f.read_text() == "a\nb\nc\n"
    assert n == 3  # trailing newline not counted as an extra line
