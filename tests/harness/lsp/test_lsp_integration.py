"""End-to-end test against a real pylsp server.

Marked ``lsp_integration`` (excluded from the default suite — run with ``-m lsp_integration``)
and skipped entirely when ``pylsp`` isn't on PATH.
"""

from __future__ import annotations

import os
import shutil

import pytest

from minima_harness.lsp.manager import LspManager
from minima_harness.tools.lsp import LspParams, lsp_tool

pytestmark = [
    pytest.mark.lsp_integration,
    pytest.mark.skipif(shutil.which("pylsp") is None, reason="pylsp not installed"),
]


async def _run(params: LspParams):
    return await lsp_tool().execute("c1", params, None, None)


async def test_real_pylsp_navigation_and_reap(monkeypatch, tmp_path):
    monkeypatch.setenv("MINIMA_EXPERIMENTAL_LSP", "1")
    (tmp_path / ".git").mkdir()  # make tmp_path the repo root that bounds the workspace
    (tmp_path / "a.py").write_text("def foo():\n    return 42\n")
    b = tmp_path / "b.py"
    b.write_text("from a import foo\n\nfoo()\n")
    a = tmp_path / "a.py"

    mgr = LspManager()  # a private manager so we control teardown
    monkeypatch.setattr("minima_harness.tools.lsp.get_manager", lambda: mgr)

    try:
        res = await _run(LspParams(operation="definition", file=str(b), line=3, symbol="foo"))
        assert "a.py:1" in res.content[0].text

        res = await _run(LspParams(operation="references", file=str(a), line=1, symbol="foo"))
        assert res.details["count"] >= 1

        res = await _run(LspParams(operation="documentSymbol", file=str(a)))
        assert "foo" in res.content[0].text

        pid = next(iter(mgr._clients.values())).pid
    finally:
        await mgr.shutdown_all()

    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)  # the server process was reaped
