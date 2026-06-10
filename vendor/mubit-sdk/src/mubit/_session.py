"""
SessionContext — contextvars-based implicit session tracking.

Eliminates the need to pass session_id to every call.
"""

import contextvars
import uuid
from dataclasses import dataclass, field
from typing import Optional

_active_session: contextvars.ContextVar["SessionContext"] = contextvars.ContextVar(
    "mubit_session"
)


@dataclass
class SessionContext:
    """Ambient session state, stored in contextvars."""

    session_id: str
    agent_id: str
    run_id: str
    user_id: str = ""
    project_id: str = ""
    parent: Optional["SessionContext"] = field(default=None, repr=False)

    @staticmethod
    def current() -> Optional["SessionContext"]:
        """Return the active session context, or None."""
        return _active_session.get(None)

    @staticmethod
    def require() -> "SessionContext":
        """Return the active session, raising if none is set."""
        ctx = _active_session.get(None)
        if ctx is None:
            raise RuntimeError(
                "No active mubit session. Call mubit.init() or use "
                "@mubit.agent / mubit.session() to create one."
            )
        return ctx

    def activate(self) -> contextvars.Token:
        """Push this session as the active context. Returns a token for reset."""
        return _active_session.set(self)

    @staticmethod
    def reset(token: contextvars.Token) -> None:
        """Restore the previous session context."""
        _active_session.reset(token)

    def child(
        self,
        agent_id: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> "SessionContext":
        """Create a child session context inheriting from this one."""
        return SessionContext(
            session_id=session_id or f"sess-{uuid.uuid4()}",
            agent_id=agent_id or self.agent_id,
            run_id=self.run_id,
            user_id=self.user_id,
            project_id=self.project_id,
            parent=self,
        )
