"""Tests for the ``lsp`` tool surface, with the manager/client mocked (no real pylsp)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from minima_harness.lsp.protocol import LspNotInstalled
from minima_harness.tools.lsp import LspParams, lsp_tool


class _FakeClient:
    def __init__(self, responses: dict) -> None:
        self.responses = responses
        self.opened: list[Path] = []
        self.closed: list[Path] = []

    async def did_open(self, path: Path) -> str:
        self.opened.append(path)
        return path.resolve().as_uri()

    async def did_close(self, path: Path) -> None:
        self.closed.append(path)

    async def definition(self, uri, position):  # noqa: ANN001
        return self.responses.get("definition")

    async def references(self, uri, position):  # noqa: ANN001
        return self.responses.get("references")

    async def hover(self, uri, position):  # noqa: ANN001
        return self.responses.get("hover")

    async def document_symbol(self, uri):  # noqa: ANN001
        return self.responses.get("documentSymbol")


class _FakeManager:
    def __init__(self, client: _FakeClient) -> None:
        self._client = client
        self._lock = asyncio.Lock()

    async def get(self, language: str, root: str) -> _FakeClient:
        return self._client

    def op_lock(self, language: str, root: str) -> asyncio.Lock:
        return self._lock


def _install(monkeypatch, client: _FakeClient) -> None:
    monkeypatch.setenv("MINIMA_EXPERIMENTAL_LSP", "1")
    monkeypatch.setattr("minima_harness.tools.lsp.get_manager", lambda: _FakeManager(client))


async def _run(params: LspParams):
    return await lsp_tool().execute("c1", params, None, None)


def _loc(uri: str, line: int, char: int) -> dict:
    return {"uri": uri, "range": {"start": {"line": line, "character": char}}}


def test_descriptor():
    t = lsp_tool()
    assert t.name == "lsp"
    assert t.parameters is LspParams


async def test_gate_off_returns_message(monkeypatch, tmp_path):
    monkeypatch.delenv("MINIMA_EXPERIMENTAL_LSP", raising=False)
    f = tmp_path / "a.py"
    f.write_text("x = 1\n")
    res = await _run(LspParams(operation="documentSymbol", file=str(f)))
    assert "MINIMA_EXPERIMENTAL_LSP" in res.content[0].text


async def test_definition_formats_location_one_based(monkeypatch, tmp_path):
    src = tmp_path / "m.py"
    src.write_text("def foo():\n    return 1\n\nfoo()\n")
    client = _FakeClient({"definition": _loc(src.resolve().as_uri(), 0, 4)})
    _install(monkeypatch, client)
    res = await _run(LspParams(operation="definition", file=str(src), line=4, symbol="foo"))
    text = res.content[0].text
    assert f"{src}:1:5" in text  # 0-based (0,4) -> 1-based 1:5
    assert "def foo()" in text
    assert res.details["count"] == 1
    assert client.opened and client.closed  # did_open + did_close ran


async def test_symbol_not_found_gives_hint(monkeypatch, tmp_path):
    src = tmp_path / "m.py"
    src.write_text("a = 1\nb = 2\n")
    _install(monkeypatch, _FakeClient({}))
    res = await _run(LspParams(operation="definition", file=str(src), line=1, symbol="zzz"))
    assert "not found" in res.content[0].text.lower()


async def test_references_multiple(monkeypatch, tmp_path):
    src = tmp_path / "m.py"
    src.write_text("def foo():\n    pass\nfoo()\nfoo()\n")
    u = src.resolve().as_uri()
    client = _FakeClient({"references": [_loc(u, 0, 4), _loc(u, 2, 0), _loc(u, 3, 0)]})
    _install(monkeypatch, client)
    res = await _run(LspParams(operation="references", file=str(src), line=1, symbol="foo"))
    assert "3 references" in res.content[0].text
    assert res.details["count"] == 3


async def test_references_empty(monkeypatch, tmp_path):
    src = tmp_path / "m.py"
    src.write_text("x = 1\n")
    _install(monkeypatch, _FakeClient({"references": []}))
    res = await _run(LspParams(operation="references", file=str(src), line=1, symbol="x"))
    assert "no references" in res.content[0].text.lower()


async def test_hover_extracts_markup_value(monkeypatch, tmp_path):
    src = tmp_path / "m.py"
    src.write_text("x = 1\n")
    hover = {"contents": {"kind": "markdown", "value": "int"}}
    _install(monkeypatch, _FakeClient({"hover": hover}))
    res = await _run(LspParams(operation="hover", file=str(src), line=1, symbol="x"))
    assert "int" in res.content[0].text


async def test_document_symbol_flattens_hierarchy(monkeypatch, tmp_path):
    src = tmp_path / "m.py"
    src.write_text("class A:\n    def m(self):\n        pass\n")
    syms = [
        {
            "name": "A",
            "kind": 5,
            "range": {"start": {"line": 0, "character": 0}},
            "selectionRange": {"start": {"line": 0, "character": 6}},
            "children": [
                {
                    "name": "m",
                    "kind": 6,
                    "range": {"start": {"line": 1, "character": 4}},
                    "selectionRange": {"start": {"line": 1, "character": 8}},
                    "children": [],
                }
            ],
        }
    ]
    _install(monkeypatch, _FakeClient({"documentSymbol": syms}))
    res = await _run(LspParams(operation="documentSymbol", file=str(src)))
    text = res.content[0].text
    assert "class A" in text
    assert "method m" in text
    assert res.details["count"] == 2


async def test_unsupported_file_type(monkeypatch, tmp_path):
    monkeypatch.setenv("MINIMA_EXPERIMENTAL_LSP", "1")
    f = tmp_path / "a.rs"
    f.write_text("fn main() {}\n")
    res = await _run(LspParams(operation="documentSymbol", file=str(f)))
    assert "python" in res.content[0].text.lower()


async def test_missing_file(monkeypatch, tmp_path):
    monkeypatch.setenv("MINIMA_EXPERIMENTAL_LSP", "1")
    res = await _run(LspParams(operation="documentSymbol", file=str(tmp_path / "nope.py")))
    assert "no such file" in res.content[0].text.lower()


async def test_missing_position_args(monkeypatch, tmp_path):
    src = tmp_path / "m.py"
    src.write_text("x = 1\n")
    monkeypatch.setenv("MINIMA_EXPERIMENTAL_LSP", "1")
    res = await _run(LspParams(operation="definition", file=str(src)))  # no line/symbol
    assert "needs" in res.content[0].text.lower()


async def test_pylsp_not_installed(monkeypatch, tmp_path):
    src = tmp_path / "m.py"
    src.write_text("x = 1\n")
    monkeypatch.setenv("MINIMA_EXPERIMENTAL_LSP", "1")

    class _Mgr:
        async def get(self, *a):  # noqa: ANN002
            raise LspNotInstalled("nope")

        def op_lock(self, *a):  # noqa: ANN002
            return asyncio.Lock()

    monkeypatch.setattr("minima_harness.tools.lsp.get_manager", lambda: _Mgr())
    res = await _run(LspParams(operation="documentSymbol", file=str(src)))
    assert "python-lsp-server" in res.content[0].text
