from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from minima_harness.session.format import EntryType, SessionEntry, new_id

_log = logging.getLogger("minima_harness.session")


class SessionStore:
    """Append-only JSONL session tree. File-backed or in-memory (``--no-session``)."""

    def __init__(self, path: Path | None, *, display_name: str | None = None) -> None:
        self._path = path
        self._mem: list[SessionEntry] = []
        self._tip: str | None = None
        self.display_name = display_name
        if path is not None and path.exists():
            self._reload()

    @classmethod
    def file_backed(cls, path: Path, *, display_name: str | None = None) -> SessionStore:
        return cls(path, display_name=display_name)

    @classmethod
    def in_memory(cls) -> SessionStore:
        return cls(None)

    @property
    def path(self) -> Path | None:
        return self._path

    @property
    def persistent(self) -> bool:
        return self._path is not None

    @property
    def entries(self) -> list[SessionEntry]:
        return list(self._mem)

    @property
    def tip(self) -> str | None:
        return self._tip

    def append(
        self, entry_type: EntryType, payload: dict, *, label: str | None = None
    ) -> SessionEntry:
        entry = SessionEntry(
            id=new_id(),
            parent_id=self._tip,
            type=entry_type,
            payload=payload,
            label=label,
        )
        self._mem.append(entry)
        self._tip = entry.id
        if self._path is not None:
            try:
                with self._path.open("a", encoding="utf-8") as fh:
                    fh.write(entry.model_dump_json() + "\n")
            except OSError:  # noqa: BLE001 - disk failure must not kill the turn
                _log.warning("session_append_failed", exc_info=True)
        return entry

    def set_tip(self, entry_id: str) -> None:
        """Branch: continue the next append from ``entry_id`` (must already exist)."""
        if not any(e.id == entry_id for e in self._mem):
            raise KeyError(f"unknown entry id: {entry_id}")
        self._tip = entry_id

    def path_to(self, entry_id: str) -> list[SessionEntry]:
        """Root → entry_id path (inclusive). Raises KeyError if unknown."""
        by_id = {e.id: e for e in self._mem}
        if entry_id not in by_id:
            raise KeyError(f"unknown entry id: {entry_id}")
        out: list[SessionEntry] = []
        cur: str | None = entry_id
        while cur is not None and cur in by_id:
            out.append(by_id[cur])
            cur = by_id[cur].parent_id
        out.reverse()
        return out

    def children_map(self) -> dict[str | None, list[str]]:
        """parentId → child ids in insertion order (root key is None)."""
        cm: dict[str | None, list[str]] = {}
        for e in self._mem:
            cm.setdefault(e.parent_id, []).append(e.id)
        return cm

    def _write_path(self, dest: Path, entries: list[SessionEntry]) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("w", encoding="utf-8") as fh:
            for e in entries:
                fh.write(e.model_dump_json() + "\n")

    def fork_to(self, dest: Path, *, from_entry_id: str) -> SessionStore:
        """Copy the root→from_entry_id path into a new session file."""
        path = self.path_to(from_entry_id)
        self._write_path(dest, path)
        return SessionStore.file_backed(dest)

    def clone_to(self, dest: Path) -> SessionStore:
        """Copy the current branch (root→tip) into a new session file."""
        if self._tip is None:
            self._write_path(dest, [])
            return SessionStore.file_backed(dest)
        return self.fork_to(dest, from_entry_id=self._tip)

    def _reload(self) -> None:
        assert self._path is not None
        self._mem = []
        for line in self._path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                self._mem.append(SessionEntry.model_validate_json(line))
            except Exception:  # noqa: BLE001 - one bad line must not lose the session
                _log.warning("session_skipped_malformed_line")
        self._tip = self._mem[-1].id if self._mem else None


@dataclass(slots=True)
class SessionSummary:
    session_id: str
    path: Path
    display_name: str | None
    mtime: float
    n_entries: int


class SessionManager:
    """Discovers/creates session files under ``<sessions_dir>/<cwd-slug>/<uuid>.jsonl``."""

    def __init__(self, sessions_dir: Path | None = None) -> None:
        base = sessions_dir or Path.home() / ".minima-harness" / "sessions"
        self._base = Path(base)

    def slug_for(self, directory: Path) -> str:
        directory = Path(directory).resolve()
        slug = str(directory).replace(os.sep, "-").replace("/", "-")
        return slug.lstrip("-") or "root"

    def _dir_for(self, directory: Path) -> Path:
        d = self._base / self.slug_for(directory)
        d.mkdir(parents=True, exist_ok=True)
        return d

    def new(self, directory: Path, *, name: str | None = None) -> SessionStore:
        sid = new_id()
        path = self._dir_for(directory) / f"{sid}.jsonl"
        return SessionStore.file_backed(path, display_name=name)

    def open(
        self,
        directory: Path,
        *,
        session_id: str | None = None,
        no_session: bool = False,
    ) -> SessionStore:
        if no_session:
            return SessionStore.in_memory()
        if session_id:
            for s in self.list_sessions(directory):
                if s.session_id.startswith(session_id) or session_id.startswith(s.session_id):
                    return SessionStore.file_backed(s.path, display_name=s.display_name)
            raise FileNotFoundError(f"no session matching id: {session_id}")
        recent = self.most_recent(directory)
        if recent is not None:
            return SessionStore.file_backed(recent.path, display_name=recent.display_name)
        return self.new(directory)

    def most_recent(self, directory: Path) -> SessionSummary | None:
        sessions = self.list_sessions(directory)
        return max(sessions, key=lambda s: s.mtime) if sessions else None

    def list_sessions(self, directory: Path) -> list[SessionSummary]:
        d = self._base / self.slug_for(directory)
        if not d.exists():
            return []
        out: list[SessionSummary] = []
        for p in sorted(d.glob("*.jsonl")):
            try:
                lines = p.read_text(encoding="utf-8").splitlines()
                count = sum(1 for ln in lines if ln.strip())
            except OSError:  # noqa: BLE001
                continue
            out.append(
                SessionSummary(
                    session_id=p.stem,
                    path=p,
                    display_name=None,
                    mtime=p.stat().st_mtime,
                    n_entries=count,
                )
            )
        return out
