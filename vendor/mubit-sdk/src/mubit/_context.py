"""
MubitContext — singleton holding the initialized SDK state.

Created by mubit.init(), holds the Client, RunManager, LessonCache,
and provides the backing for module-level helpers.
"""

import logging
from typing import Optional, List

logger = logging.getLogger("mubit")


class MubitContext:
    """Global SDK state created by mubit.init()."""

    def __init__(
        self,
        client,
        learn_config=None,
        learn_client=None,
        lesson_cache=None,
        run_manager=None,
        prompt_cache=None,
        auto_instrument: bool = True,
        auto_learn: bool = True,
        fail_open: bool = True,
    ):
        self.client = client
        self.learn_config = learn_config
        self.learn_client = learn_client
        self.lesson_cache = lesson_cache
        self.run_manager = run_manager
        self.prompt_cache = prompt_cache
        self.auto_instrument = auto_instrument
        self.auto_learn = auto_learn
        self.fail_open = fail_open
        # Server-assigned IDs from CreateControlSession.
        # session_id and run_id are semantically distinct on the server:
        #   - session_id ("sess-{uuid}"): user-facing identifier for a conversation/workflow
        #   - run_id ("run-{uuid}"): internal identifier for a single agent execution run
        # Most SDK users only interact with session_id; run_id is managed internally.
        self._server_session_id: Optional[str] = None
        self._server_run_id: Optional[str] = None

    @property
    def session_id(self) -> Optional[str]:
        """Server-assigned session ID (user-facing)."""
        return self._server_session_id

    @property
    def run_id(self) -> Optional[str]:
        """Server-assigned run ID (internal; maps 1:1 with session at session creation)."""
        return self._server_run_id


# Module-level singleton
_context: Optional[MubitContext] = None


def get_context() -> Optional[MubitContext]:
    """Return the active MubitContext, or None if init() hasn't been called."""
    return _context


def set_context(ctx: MubitContext) -> None:
    """Set the active MubitContext."""
    global _context
    _context = ctx


def require_context() -> MubitContext:
    """Return the active MubitContext, raising if init() hasn't been called."""
    if _context is None:
        raise RuntimeError(
            "mubit.init() must be called before using module-level helpers. "
            "Call mubit.init() or mubit.init(api_key='...') first."
        )
    return _context
