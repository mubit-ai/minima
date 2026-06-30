"""apply_patch — atomic multi-file, multi-hunk edits in one tool call.

A single ``edit`` does one ``old_string -> new_string`` swap, so a change spanning
three files costs three tool calls (three model round-trips) and can leave a
half-applied refactor if a later one fails. ``apply_patch`` takes one patch
describing adds/updates/deletes/moves across many files, resolves every hunk in
memory first, and only touches disk if *all* of them resolve — all-or-nothing.

The patch grammar mirrors the format Codex/OpenCode converged on::

    *** Begin Patch
    *** Add File: path/to/new.py
    +line one
    +line two
    *** Update File: path/to/existing.py
    *** Move to: path/to/renamed.py
    @@ optional anchor (e.g. a function signature in a big file)
     context line kept as-is
    -removed line
    +added line
    *** Delete File: path/to/old.py
    *** End Patch

Within an ``Update File`` hunk each line is prefixed by ``' '`` (context, kept),
``'-'`` (removed), or ``'+'`` (added). ``@@`` starts a new hunk and may carry an
anchor line to disambiguate location in large files. Matching tolerates trailing-
and (as a last resort) leading-whitespace drift so models needn't reproduce
indentation byte-for-byte.
"""

from __future__ import annotations

import difflib
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import BaseModel

from minima_harness.agent.tools import AgentTool, ToolResult, error_result
from minima_harness.ai.types import TextContent

_BEGIN = "*** Begin Patch"
_END = "*** End Patch"
_ADD = "*** Add File: "
_UPDATE = "*** Update File: "
_DELETE = "*** Delete File: "
_MOVE = "*** Move to: "
_EOF = "*** End of File"

# Reader: relative-or-absolute path -> file text, or None if it doesn't exist.
ReadFile = Callable[[str], "str | None"]


class ApplyPatchParams(BaseModel):
    patch: str


class PatchError(ValueError):
    """A patch is malformed or cannot be applied cleanly to the current files."""


@dataclass(slots=True)
class Hunk:
    before: list[str]  # context + removed lines (prefix stripped), in file order
    after: list[str]  # context + added lines (prefix stripped), in file order
    anchor: str | None = None  # optional @@ heading to seek before matching


@dataclass(slots=True)
class FileChange:
    kind: str  # "add" | "update" | "delete"
    path: str
    move_to: str | None = None
    new_content: str | None = None  # for "add"
    hunks: list[Hunk] = field(default_factory=list)  # for "update"


@dataclass(slots=True)
class PatchPlan:
    writes: dict[str, str]  # path -> full new content
    deletes: list[str]  # paths to remove
    summary: list[str]  # one human-readable line per change


# --------------------------------------------------------------------------- parse


def parse_patch(text: str) -> list[FileChange]:
    """Parse patch text into file changes. Raises PatchError on malformed input."""
    lines = text.splitlines()
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i >= len(lines) or lines[i].strip() != _BEGIN:
        raise PatchError("patch must start with '*** Begin Patch'")
    i += 1
    changes: list[FileChange] = []
    while i < len(lines):
        line = lines[i]
        s = line.strip()
        if s == _END:
            return changes
        if s == _EOF or not s:
            i += 1
            continue
        if line.startswith(_ADD):
            path = line[len(_ADD) :].strip()
            content, i = _parse_added_lines(lines, i + 1)
            changes.append(FileChange(kind="add", path=path, new_content=content))
            continue
        if line.startswith(_DELETE):
            changes.append(FileChange(kind="delete", path=line[len(_DELETE) :].strip()))
            i += 1
            continue
        if line.startswith(_UPDATE):
            path = line[len(_UPDATE) :].strip()
            i += 1
            move_to = None
            if i < len(lines) and lines[i].startswith(_MOVE):
                move_to = lines[i][len(_MOVE) :].strip()
                i += 1
            hunks, i = _parse_hunks(lines, i)
            if not hunks:
                raise PatchError(f"Update File: {path}: no hunks")
            changes.append(FileChange(kind="update", path=path, move_to=move_to, hunks=hunks))
            continue
        raise PatchError(f"unexpected line in patch: {line!r}")
    raise PatchError("patch missing '*** End Patch'")


def _parse_added_lines(lines: list[str], i: int) -> tuple[str, int]:
    out: list[str] = []
    while i < len(lines) and not lines[i].startswith("*** "):
        cl = lines[i]
        if cl.startswith("+"):
            out.append(cl[1:])
        elif not cl.strip():
            out.append("")
        else:
            raise PatchError(f"Add File lines must start with '+': {cl!r}")
        i += 1
    return "\n".join(out), i


def _parse_hunks(lines: list[str], i: int) -> tuple[list[Hunk], int]:
    hunks: list[Hunk] = []
    before: list[str] = []
    after: list[str] = []
    anchor: str | None = None

    def flush() -> None:
        nonlocal before, after, anchor
        if before or after:
            hunks.append(Hunk(before=before, after=after, anchor=anchor))
        before, after, anchor = [], [], None

    while i < len(lines):
        line = lines[i]
        if line.startswith("*** "):
            break
        if line.startswith("@@"):
            flush()
            anchor = line[2:].strip() or None
            i += 1
            continue
        if line.startswith("+"):
            after.append(line[1:])
        elif line.startswith("-"):
            before.append(line[1:])
        elif line.startswith(" "):
            before.append(line[1:])
            after.append(line[1:])
        elif line == "":  # blank context line emitted without the leading space
            before.append("")
            after.append("")
        else:
            raise PatchError(f"hunk line must start with ' ', '+', or '-': {line!r}")
        i += 1
    flush()
    return hunks, i


# --------------------------------------------------------------------------- plan


def plan_patch(changes: list[FileChange], read_file: ReadFile) -> PatchPlan:
    """Resolve every change against current file contents WITHOUT touching disk.

    Raises PatchError if any add collides, any delete/update target is missing, or
    any hunk fails to locate its context — so the caller can apply atomically."""
    writes: dict[str, str] = {}
    deletes: list[str] = []
    summary: list[str] = []
    for ch in changes:
        if ch.kind == "add":
            if read_file(ch.path) is not None:
                raise PatchError(f"Add File: {ch.path} already exists")
            content = ch.new_content or ""
            if content and not content.endswith("\n"):
                content += "\n"
            writes[ch.path] = content
            summary.append(f"add    {ch.path}")
        elif ch.kind == "delete":
            if read_file(ch.path) is None:
                raise PatchError(f"Delete File: {ch.path} does not exist")
            deletes.append(ch.path)
            summary.append(f"delete {ch.path}")
        elif ch.kind == "update":
            original = read_file(ch.path)
            if original is None:
                raise PatchError(f"Update File: {ch.path} does not exist")
            new_text = _apply_hunks(original, ch.hunks, ch.path)
            dest = ch.move_to or ch.path
            if ch.move_to:
                deletes.append(ch.path)
                summary.append(f"move   {ch.path} -> {ch.move_to}")
            else:
                summary.append(f"update {ch.path}")
            writes[dest] = new_text
        else:  # pragma: no cover - parse never produces other kinds
            raise PatchError(f"unknown change kind: {ch.kind}")
    return PatchPlan(writes=writes, deletes=deletes, summary=summary)


def _apply_hunks(original: str, hunks: list[Hunk], path: str) -> str:
    had_final_nl = original.endswith("\n")
    out = original.splitlines()
    cursor = 0
    for h in hunks:
        start = cursor
        if h.anchor:
            a = _find_anchor(out, h.anchor, cursor)
            if a >= 0:
                start = a
        idx = _find(out, h.before, start)
        if idx < 0 and start > 0:  # context may sit before the cursor — retry from top
            idx = _find(out, h.before, 0)
        if idx < 0:
            ctx = "\n".join(h.before[:6]) or "(no context lines)"
            raise PatchError(f"Update File: {path}: could not locate hunk context:\n{ctx}")
        out[idx : idx + len(h.before)] = h.after
        cursor = idx + len(h.after)
    text = "\n".join(out)
    if had_final_nl and not text.endswith("\n"):
        text += "\n"
    return text


def _find(hay: list[str], needle: list[str], start: int) -> int:
    """First index >= start where needle matches, trying progressively looser
    whitespace normalization. Empty needle matches at start (pure insertion)."""
    if not needle:
        return start
    span = len(needle)
    last = len(hay) - span
    for norm in (lambda x: x, str.rstrip, str.strip):
        target = [norm(x) for x in needle]
        for i in range(max(start, 0), last + 1):
            if [norm(x) for x in hay[i : i + span]] == target:
                return i
    return -1


def _find_anchor(hay: list[str], anchor: str, start: int) -> int:
    target = anchor.strip()
    for i in range(max(start, 0), len(hay)):
        if hay[i].strip() == target:
            return i
    return -1


# --------------------------------------------------------------------------- apply


def disk_reader(root: Path) -> ReadFile:
    """A ReadFile that resolves relative paths under ``root`` and reads from disk."""

    def read(rel: str) -> str | None:
        p = Path(rel) if Path(rel).is_absolute() else root / rel
        try:
            return p.expanduser().read_text(encoding="utf-8")
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            return None

    return read


def write_plan(plan: PatchPlan, root: Path) -> None:
    """Flush a resolved plan to disk: writes (with mkdir) first, then deletes."""
    for rel, content in plan.writes.items():
        p = Path(rel) if Path(rel).is_absolute() else root / rel
        p = p.expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    for rel in plan.deletes:
        if rel in plan.writes:  # a moved-to-itself or re-created path; keep it
            continue
        p = Path(rel) if Path(rel).is_absolute() else root / rel
        p.expanduser().unlink(missing_ok=True)


def patch_preview(patch: str, root: Path) -> str:
    """A unified-diff preview of what the patch would do, for the approval modal."""
    try:
        plan = plan_patch(parse_patch(patch), disk_reader(root))
    except PatchError as e:
        return f"apply_patch: {e}\n---\n{patch}"
    read = disk_reader(root)
    blocks: list[str] = []
    for rel, content in plan.writes.items():
        before = read(rel)
        d = difflib.unified_diff(
            (before or "").splitlines(),
            content.splitlines(),
            fromfile="/dev/null" if before is None else f"a/{rel}",
            tofile=f"b/{rel}",
            lineterm="",
        )
        blocks.append("\n".join(d) or f"{rel} (no change)")
    for rel in plan.deletes:
        if rel not in plan.writes:
            blocks.append(f"--- a/{rel}\n+++ /dev/null (deleted)")
    return "\n".join(blocks) or "apply_patch: empty patch"


def summarize_patch(patch: str) -> str:
    """A compact one-block summary of the patch for the transcript."""
    try:
        changes = parse_patch(patch)
    except PatchError as e:
        return f"apply_patch: {e}"
    rows: list[str] = []
    for ch in changes:
        if ch.kind == "add":
            rows.append(f"add    {ch.path}")
        elif ch.kind == "delete":
            rows.append(f"delete {ch.path}")
        elif ch.move_to:
            rows.append(f"move   {ch.path} -> {ch.move_to}")
        else:
            plural = "s" if len(ch.hunks) != 1 else ""
            rows.append(f"update {ch.path}  ({len(ch.hunks)} hunk{plural})")
    n = len(rows)
    head = f"apply_patch: {n} file{'s' if n != 1 else ''}"
    return head + "\n" + "\n".join(rows) if rows else head


async def _execute(tool_call_id: str, params, signal, on_update) -> ToolResult:  # noqa: ANN001
    assert isinstance(params, ApplyPatchParams)
    root = Path.cwd()
    try:
        changes = parse_patch(params.patch)
        if not changes:
            return error_result("apply_patch: empty patch (no file sections)")
        plan = plan_patch(changes, disk_reader(root))
    except PatchError as e:
        return error_result(f"apply_patch: {e}")
    write_plan(plan, root)
    summary = "\n".join(plan.summary)
    return ToolResult(
        content=[TextContent(text=f"applied patch ({len(changes)} change(s)):\n{summary}")],
        details={"writes": list(plan.writes), "deletes": plan.deletes},
    )


def apply_patch_tool() -> AgentTool:
    return AgentTool(
        name="apply_patch",
        description=(
            "Apply a multi-file patch atomically in one call — add, update, delete, or move "
            "files together. Prefer this over multiple `edit` calls for any change touching "
            "more than one file or more than one region. Every hunk is resolved before "
            "anything is written; if any hunk fails to match, NO file is changed.\n\n"
            "Format:\n"
            "*** Begin Patch\n"
            "*** Add File: path/new.py\n"
            "+full contents, each line prefixed with +\n"
            "*** Update File: path/existing.py\n"
            "*** Move to: path/renamed.py   (optional; omit to edit in place)\n"
            "@@ optional anchor line for large files\n"
            " unchanged context line (leading space)\n"
            "-removed line\n"
            "+added line\n"
            "*** Delete File: path/old.py\n"
            "*** End Patch\n\n"
            "Include a few unchanged context lines (leading space) around each change so the "
            "hunk can be located. Paths are relative to the working directory."
        ),
        parameters=ApplyPatchParams,
        execute=_execute,
    )
