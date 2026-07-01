"""The ``lsp`` tool — semantic code navigation via a language server.

Where ``grep`` finds *text*, ``lsp`` finds *meaning*: the definition a name binds to, every
reference to it, hover docs, or a file's symbol outline. v1 supports Python only (via
``pylsp``) and is experimental — it does nothing unless ``MINIMA_EXPERIMENTAL_LSP`` is set.
Results are ``file:line:col`` (1-based) with the source line, so the model can follow up with
``read``.
"""

from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlparse

from pydantic import BaseModel, Field

from minima_harness.agent.tools import AgentTool, ToolResult, error_result
from minima_harness.ai.types import TextContent
from minima_harness.lsp import lsp_enabled
from minima_harness.lsp.client import utf16_len
from minima_harness.lsp.manager import get_manager
from minima_harness.lsp.protocol import LspError, LspNotInstalled, LspServerDied, LspTimeout

_EXT_LANGUAGE = {".py": "python", ".pyi": "python"}

# LSP SymbolKind (1-based) -> short label, for documentSymbol output.
_SYMBOL_KIND = {
    1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
    6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
    11: "interface", 12: "function", 13: "variable", 14: "constant",
    15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object",
    20: "key", 21: "null", 22: "enum-member", 23: "struct", 24: "event",
    25: "operator", 26: "type-parameter",
}

_HOVER_CAP = 2000


class LspParams(BaseModel):
    operation: Literal["definition", "references", "hover", "documentSymbol"] = Field(
        description="definition: where a symbol is defined. references: everywhere it is used. "
        "hover: type/doc info. documentSymbol: the file's symbol outline."
    )
    file: str = Field(description="Path to the source file (Python only in v1).")
    line: int | None = Field(
        default=None,
        ge=1,
        description="1-based line of the symbol. Required for all ops except documentSymbol.",
    )
    symbol: str | None = Field(
        default=None,
        description="The identifier on that line to resolve (its column is found for you).",
    )
    character: int | None = Field(
        default=None,
        ge=0,
        description="0-based column override; use instead of `symbol` to disambiguate.",
    )


class _SymbolNotFound(Exception):
    pass


def _language_for(path: Path) -> str | None:
    return _EXT_LANGUAGE.get(path.suffix.lower())


def _repo_root(path: Path) -> Path:
    """Nearest ancestor containing .git, else the file's directory (bounds the workspace)."""
    path = path.resolve()
    for parent in (path, *path.parents):
        if (parent / ".git").exists():
            return parent
    return path.parent


def _uri_to_path(uri: str) -> str:
    """``file:///a/b.py`` -> ``/a/b.py`` for display. Non-file URIs pass through unchanged."""
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        return uri
    return unquote(parsed.path)


def _nearby(lines: list[str], line: int, span: int = 2) -> str:
    lo = max(1, line - span)
    hi = min(len(lines), line + span)
    width = len(str(hi))
    return "\n".join(f"  {str(i).rjust(width)}: {lines[i - 1]}" for i in range(lo, hi + 1))


def _resolve_position(
    path: Path, line: int, symbol: str | None, character: int | None
) -> dict[str, int]:
    """Map a 1-based line + symbol (or explicit column) to a 0-based LSP position."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if line > len(lines):
        raise _SymbolNotFound(f"lsp: line {line} is past end of file ({len(lines)} lines)")
    text = lines[line - 1]
    if character is not None:
        col = character
    else:
        assert symbol is not None
        col = text.find(symbol)
        if col < 0:
            raise _SymbolNotFound(
                f"lsp: symbol {symbol!r} not found on {path}:{line}.\n{_nearby(lines, line)}"
            )
    # `col` is a code-point index into the line; LSP wants UTF-16 code units.
    return {"line": line - 1, "character": utf16_len(text[:col])}


def _line_text(path_str: str, line0: int) -> str:
    """The text of (0-based) line ``line0`` in a file, for context in results."""
    try:
        with open(path_str, encoding="utf-8", errors="replace") as fh:
            for i, text in enumerate(fh):
                if i == line0:
                    return text.rstrip("\n")
    except OSError:
        pass
    return ""


def _norm_locations(raw: Any) -> list[dict[str, Any]]:
    """Normalize a Location | Location[] | LocationLink[] to a list of {uri, line, char}."""
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else [raw]
    out: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        uri = it.get("uri") or it.get("targetUri")
        rng = it.get("range") or it.get("targetSelectionRange") or it.get("targetRange")
        if not uri or not isinstance(rng, dict):
            continue
        start = rng.get("start", {})
        out.append(
            {
                "uri": uri,
                "line": int(start.get("line", 0)),
                "character": int(start.get("character", 0)),
            }
        )
    return out


def _format_locations(locs: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    for loc in locs:
        disp = _uri_to_path(loc["uri"])
        snippet = _line_text(disp, loc["line"]).strip()
        suffix = f": {snippet}" if snippet else ""
        lines.append(f"{disp}:{loc['line'] + 1}:{loc['character'] + 1}{suffix}")
    return lines


def _hover_text(raw: Any) -> str:
    if not isinstance(raw, dict):
        return ""
    parts: list[str] = []

    def add(c: Any) -> None:
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, dict):  # MarkupContent {kind,value} or MarkedString {language,value}
            parts.append(str(c.get("value", "")))

    contents = raw.get("contents")
    if isinstance(contents, list):
        for c in contents:
            add(c)
    else:
        add(contents)
    text = "\n".join(p for p in parts if p).strip()
    if len(text) > _HOVER_CAP:
        text = text[:_HOVER_CAP] + "\n…(truncated)"
    return text


def _format_symbols(raw: Any, disp: str) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []

    def kind_label(k: Any) -> str:
        return _SYMBOL_KIND.get(k, "symbol") if isinstance(k, int) else "symbol"

    def walk(sym: dict[str, Any], depth: int) -> None:
        if "location" in sym:  # SymbolInformation (flat)
            rng = sym["location"].get("range", {})
            target = _uri_to_path(sym["location"].get("uri", disp))
        else:  # DocumentSymbol (hierarchical)
            rng = sym.get("selectionRange") or sym.get("range") or {}
            target = disp
        start = rng.get("start", {})
        line1 = int(start.get("line", 0)) + 1
        col1 = int(start.get("character", 0)) + 1
        indent = "  " * depth
        out.append(f"{target}:{line1}:{col1}: {indent}{kind_label(sym.get('kind'))} "
                   f"{sym.get('name', '?')}")
        for child in sym.get("children") or []:
            if isinstance(child, dict):
                walk(child, depth + 1)

    for sym in raw:
        if isinstance(sym, dict):
            walk(sym, 0)
    return out


def _format_result(op: str, raw: Any, params: LspParams, path: Path) -> ToolResult:
    if op == "documentSymbol":
        symbols = _format_symbols(raw, str(path))
        if not symbols:
            return ToolResult(
                content=[TextContent(text=f"lsp: no symbols found in {path}")],
                details={"operation": op, "count": 0},
            )
        body = f"{len(symbols)} symbols in {path}:\n" + "\n".join(symbols)
        return ToolResult(
            content=[TextContent(text=body)], details={"operation": op, "count": len(symbols)}
        )

    if op == "hover":
        where = f"{path}:{params.line}"
        text = _hover_text(raw)
        if not text:
            return ToolResult(
                content=[TextContent(text=f"lsp: no hover info at {where}")],
                details={"operation": op, "count": 0},
            )
        return ToolResult(
            content=[TextContent(text=f"{where}:\n{text}")],
            details={"operation": op, "count": 1},
        )

    # definition / references
    locs = _norm_locations(raw)
    label = "definition" if op == "definition" else "references"
    if not locs:
        target = params.symbol or f"{path}:{params.line}"
        return ToolResult(
            content=[TextContent(text=f"lsp: no {label} found for {target}")],
            details={"operation": op, "count": 0},
        )
    formatted = _format_locations(locs)
    header = f"{len(formatted)} {label}:\n" if op == "references" else ""
    return ToolResult(
        content=[TextContent(text=header + "\n".join(formatted))],
        details={"operation": op, "count": len(formatted), "locations": formatted},
    )


async def _execute(
    tool_call_id: str,
    params,  # noqa: ANN001
    signal,  # noqa: ANN001
    on_update,  # noqa: ANN001
) -> ToolResult:
    assert isinstance(params, LspParams)

    if not lsp_enabled():
        return error_result(
            "lsp is experimental and disabled. Set MINIMA_EXPERIMENTAL_LSP=1 to enable it "
            "(needs the pylsp language server: pip install python-lsp-server)."
        )

    path = Path(params.file).expanduser()
    if not path.is_file():
        return error_result(f"lsp: no such file: {path}")
    language = _language_for(path)
    if language is None:
        return error_result(
            f"lsp: unsupported file type {path.suffix!r} — v1 supports Python (.py) only."
        )

    op = params.operation
    position: dict[str, int] | None = None
    if op != "documentSymbol":
        if params.line is None or (params.symbol is None and params.character is None):
            return error_result(f"lsp {op} needs `line` (1-based) and `symbol` (or `character`).")
        try:
            position = _resolve_position(path, params.line, params.symbol, params.character)
        except _SymbolNotFound as exc:
            return error_result(str(exc))

    root = str(_repo_root(path))
    mgr = get_manager()
    try:
        client = await mgr.get(language, root)
    except LspNotInstalled:
        return error_result(
            "lsp: the pylsp language server is not installed. "
            "Install it with: pip install python-lsp-server"
        )
    except (LspTimeout, LspServerDied, LspError) as exc:
        return error_result(f"lsp: language server failed to start: {exc}")

    async with mgr.op_lock(language, root):
        try:
            uri = await client.did_open(path)
            try:
                if op == "definition":
                    raw = await client.definition(uri, position or {})
                elif op == "references":
                    raw = await client.references(uri, position or {})
                elif op == "hover":
                    raw = await client.hover(uri, position or {})
                else:
                    raw = await client.document_symbol(uri)
            finally:
                with contextlib.suppress(LspError):
                    await client.did_close(path)
        except (LspTimeout, LspServerDied) as exc:
            return error_result(f"lsp: {exc} (retry to respawn the server).")
        except LspError as exc:
            return error_result(f"lsp: {exc}")

    return _format_result(op, raw, params, path)


def lsp_tool() -> AgentTool:
    return AgentTool(
        name="lsp",
        description=(
            "Semantic code navigation via a language server (Python only, experimental). "
            "Unlike grep's text matching, this resolves meaning. operation=definition (where a "
            "name is defined) | references (everywhere it's used) | hover (type/docs) | "
            "documentSymbol (a file's outline). Pass `file`; for everything but documentSymbol "
            "also pass the 1-based `line` and the `symbol` identifier on it (or a 0-based "
            "`character`). Returns file:line:col locations with the source line — follow up with "
            "`read`. Requires MINIMA_EXPERIMENTAL_LSP=1 and the pylsp server."
        ),
        parameters=LspParams,
        execute=_execute,
    )
