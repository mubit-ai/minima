"""
MuBit Learn LiteLLM Integration.

Extends the existing auto-capture LiteLLM callback with pre-call lesson
injection via litellm.callbacks.
"""

import logging
from typing import Any, Dict, List, Optional

from mubit.learn._client import LearnClient
from mubit.learn._config import LearnConfig
from mubit.learn._injection import extract_query, inject_context_openai
from mubit.learn._lesson_cache import LessonCache
from mubit.learn._run_manager import RunManager

logger = logging.getLogger("mubit.learn")


class MubitLearnLiteLLMCallback:
    """LiteLLM callback that injects lessons before each call.

    This callback works alongside the auto-capture LiteLLM logger
    (which handles ingestion). This callback handles the pre-call
    context enrichment.
    """

    def __init__(
        self,
        learn_config: LearnConfig,
        lesson_cache: LessonCache,
        learn_client: LearnClient,
        run_manager: RunManager,
    ):
        self._config = learn_config
        self._cache = lesson_cache
        self._client = learn_client
        self._run_manager = run_manager

    def log_pre_api_call(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        kwargs: Dict[str, Any],
    ) -> None:
        """Called by litellm before the API call. Modifies kwargs in-place."""
        if not self._config.inject_lessons:
            return

        query = extract_query(messages)
        if not query:
            return

        sid = self._run_manager.session_id
        context_block = self._cache.get(sid, query)
        if context_block is None:
            try:
                context_block, ids = self._client.get_context_with_ids(
                    session_id=sid,
                    query=query,
                    max_token_budget=self._config.max_token_budget,
                    entry_types=self._config.entry_types,
                    sections=self._config.context_sections,
                    timeout=self._config.context_fetch_timeout,
                )
                self._cache.set(sid, query, context_block, ids)
            except Exception as e:
                if self._config.fail_open:
                    logger.debug("mubit.learn litellm pre-call failed: %s", e)
                    return
                raise
        else:
            ids = self._cache.get_ids(sid, query)

        # Stash recalled IDs so feedback() can credit them later.
        self._run_manager.set_recalled_ids(ids)

        if context_block:
            enriched = inject_context_openai(
                messages, context_block, self._config.injection_position
            )
            # LiteLLM passes messages by reference in kwargs
            if "messages" in kwargs:
                kwargs["messages"] = enriched

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        """Called after successful API call."""
        self._run_manager.increment()

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        """Called after failed API call."""
        self._run_manager.increment()
