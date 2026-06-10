"""
MuBit Learn — Closed-loop agentic memory with one-liner setup.

Usage::

    import mubit.learn

    mubit.learn.init(api_key="mbt_...", agent_id="my-agent")

    # All OpenAI/Anthropic/LiteLLM/Google GenAI calls now auto-ingest
    # traces AND auto-inject relevant lessons before each call.

    @mubit.learn.run(agent_id="planner")
    def plan(task):
        client = openai.OpenAI()
        return client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": task}],
        ).choices[0].message.content

    # For raw HTTP or unsupported LLM libraries, use manual helpers:
    context = mubit.learn.get_lessons("user question")
    # ... make your LLM call ...
    mubit.learn.capture(
        messages=[{"role": "user", "content": "question"}],
        response="answer",
        model="gpt-4o",
    )
"""

import atexit
import functools
import inspect
import json
import logging
import uuid
from typing import Any, Callable, Dict, List, Optional, TypeVar

from mubit.auto._context import Span, set_current_span, get_current_span
from mubit.auto._items import build_items
from mubit.auto._worker import IngestWorker
from mubit.learn._attribution import attribute_outcome
from mubit.learn._client import LearnClient
from mubit.learn._config import LearnConfig
from mubit.learn._lesson_cache import LessonCache
from mubit.learn._run_manager import RunManager

logger = logging.getLogger("mubit.learn")

F = TypeVar("F", bound=Callable[..., Any])

# Module-level state
_active_config: Optional[LearnConfig] = None
_learn_client: Optional[LearnClient] = None
_lesson_cache: Optional[LessonCache] = None
_run_manager: Optional[RunManager] = None
_ingest_worker: Optional[IngestWorker] = None
_original_refs: dict = {}


def init(
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
    agent_id: str = "auto",
    user_id: str = "",
    session_id: Optional[str] = None,
    *,
    inject_lessons: bool = True,
    injection_position: str = "system",
    max_token_budget: int = 2048,
    entry_types: Optional[List[str]] = None,
    context_sections: Optional[List[str]] = None,
    capture: str = "all",
    min_length: int = 0,
    lane: str = "",
    auto_extract: bool = True,
    extraction_mode: str = "heuristic",
    auto_reflect: bool = True,
    reflect_after_n_calls: Optional[int] = None,
    context_fetch_timeout: float = 5.0,
    cache_ttl_seconds: float = 30.0,
    cache_max_entries: int = 100,
    fail_open: bool = True,
    patch_globals: bool = True,
) -> "RunManager":
    """Initialize mubit.learn — one-liner self-improving agentic memory.

    After calling init(), all OpenAI/Anthropic/LiteLLM/Google-GenAI client
    instances will automatically:
    - Retrieve relevant lessons and inject them before each LLM call
    - Ingest all inputs and outputs in the background
    - Reflect when the run ends, turning experience into validated lessons

    The auto path deliberately does NOT reinforce recalled entries on its own:
    an LLM call returning successfully says nothing about whether the recalled
    memory actually helped, so auto-crediting "success" would poison the store.
    Memory improves automatically via reflection (evidence-based, validation-
    gated); to credit the specific memories that helped, add one line —
    ``mubit.learn.feedback(good=True)`` (or ``feedback(score=...)``).

    Args:
        api_key: MuBit API key (falls back to MUBIT_API_KEY env var).
        endpoint: MuBit endpoint (falls back to MUBIT_ENDPOINT env var).
        agent_id: Default agent ID for all captured traces.
        user_id: Default user ID.
        session_id: Session/run ID (None = auto-generate UUID).
        inject_lessons: Whether to inject lessons before LLM calls.
        injection_position: Where to inject ("system", "prepend", "last_system").
        max_token_budget: Token budget for context retrieval.
        entry_types: Memory entry types to retrieve (None = server default).
        context_sections: Context sections to include (None = server default).
        capture: Ingestion capture mode ("all", "input_only", "output_only").
        min_length: Minimum text length to capture.
        auto_reflect: Trigger reflection when run ends.
        reflect_after_n_calls: Trigger reflection every N LLM calls (None = off).
        context_fetch_timeout: Pre-LLM lesson-injection timeout in seconds
            (hot path). Must exceed server context-assembly latency or injection
            silently no-ops under fail_open. Env override:
            MUBIT_LEARN_CONTEXT_TIMEOUT.
        cache_ttl_seconds: Lesson cache TTL in seconds.
        cache_max_entries: Max lesson cache entries.
        fail_open: If True, proceed without lessons on retrieval failure.
        patch_globals: If True (default), monkeypatch the LLM client libraries
            so every client auto-enriches. Set False to opt out and instead
            enrich specific clients explicitly via :func:`wrap`.

    Returns:
        The RunManager instance for this session.
    """
    global _active_config, _learn_client, _lesson_cache, _run_manager, _ingest_worker

    config = LearnConfig(
        api_key=api_key,
        endpoint=endpoint,
        agent_id=agent_id,
        user_id=user_id,
        session_id=session_id,
        inject_lessons=inject_lessons,
        injection_position=injection_position,
        max_token_budget=max_token_budget,
        entry_types=entry_types,
        context_sections=context_sections,
        capture=capture,
        min_length=min_length,
        lane=lane,
        auto_extract=auto_extract,
        extraction_mode=extraction_mode,
        auto_reflect=auto_reflect,
        reflect_after_n_calls=reflect_after_n_calls,
        context_fetch_timeout=context_fetch_timeout,
        cache_ttl_seconds=cache_ttl_seconds,
        cache_max_entries=cache_max_entries,
        fail_open=fail_open,
    ).resolve()

    _active_config = config
    _learn_client = LearnClient(
        config.api_key,
        config.endpoint,
        context_timeout=config.context_fetch_timeout,
        reflect_timeout=config.reflect_timeout,
        attribution_timeout=config.attribution_context_timeout,
    )
    _lesson_cache = LessonCache(config.cache_ttl_seconds, config.cache_max_entries)
    _run_manager = RunManager(config, _learn_client)
    # One shared ingest worker for the manual capture() path (the wrapped
    # clients pool their own worker). Reused across calls so capture() does not
    # spawn a thread + atexit handler per invocation.
    _ingest_worker = IngestWorker(api_key=config.api_key, endpoint=config.endpoint)
    _ingest_worker.start()

    # Register shutdown hook
    atexit.register(_shutdown)

    # Monkey-patch LLM libraries (unless the caller opts for explicit wrap()).
    if patch_globals:
        _patch_openai(config, _lesson_cache, _learn_client, _run_manager)
        _patch_anthropic(config, _lesson_cache, _learn_client, _run_manager)
        _patch_litellm(config, _lesson_cache, _learn_client, _run_manager)
        _patch_google_genai(config, _lesson_cache, _learn_client, _run_manager)

    return _run_manager


def run(
    agent_id: Optional[str] = None,
    session_id: Optional[str] = None,
    *,
    auto_reflect: Optional[bool] = None,
    inject_lessons: Optional[bool] = None,
    max_token_budget: Optional[int] = None,
) -> Callable[[F], F]:
    """Decorator for a scoped learn run.

    Creates a span with a managed session_id and triggers reflection on exit.
    Requires init() to have been called first.

    Usage::

        @mubit.learn.run(agent_id="planner")
        def my_func():
            ...  # LLM calls here auto-enriched
    """

    def decorator(fn: F) -> F:
        is_async = inspect.iscoroutinefunction(fn)

        @functools.wraps(fn)
        def sync_wrapper(*args, **kwargs):
            rm = _enter_run(agent_id, session_id, auto_reflect, inject_lessons, max_token_budget)
            try:
                return fn(*args, **kwargs)
            finally:
                rm.end()

        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            rm = _enter_run(agent_id, session_id, auto_reflect, inject_lessons, max_token_budget)
            try:
                return await fn(*args, **kwargs)
            finally:
                rm.end()

        return async_wrapper if is_async else sync_wrapper

    return decorator


def start_run(
    agent_id: Optional[str] = None,
    session_id: Optional[str] = None,
    *,
    auto_reflect: Optional[bool] = None,
) -> "RunManager":
    """Start an explicit learn run. Call run.end() when done.

    Requires init() to have been called first.

    Usage::

        run = mubit.learn.start_run(agent_id="researcher")
        # ... do work ...
        run.end()  # triggers flush + reflect
    """
    return _enter_run(agent_id, session_id, auto_reflect)


def uninstrument() -> None:
    """Restore original LLM library behavior and stop the learn module."""
    global _active_config, _learn_client, _lesson_cache, _run_manager, _ingest_worker

    # Restore OpenAI
    try:
        import openai
        if "openai.OpenAI.__init__" in _original_refs:
            openai.OpenAI.__init__ = _original_refs.pop("openai.OpenAI.__init__")
            if hasattr(openai.OpenAI, "_mubit_learn_instrumented"):
                del openai.OpenAI._mubit_learn_instrumented
        if "openai.AsyncOpenAI.__init__" in _original_refs:
            openai.AsyncOpenAI.__init__ = _original_refs.pop("openai.AsyncOpenAI.__init__")
            if hasattr(openai.AsyncOpenAI, "_mubit_learn_instrumented"):
                del openai.AsyncOpenAI._mubit_learn_instrumented
    except ImportError:
        pass

    # Restore Anthropic
    try:
        import anthropic
        if "anthropic.Anthropic.__init__" in _original_refs:
            anthropic.Anthropic.__init__ = _original_refs.pop("anthropic.Anthropic.__init__")
            if hasattr(anthropic.Anthropic, "_mubit_learn_instrumented"):
                del anthropic.Anthropic._mubit_learn_instrumented
        if "anthropic.AsyncAnthropic.__init__" in _original_refs:
            anthropic.AsyncAnthropic.__init__ = _original_refs.pop("anthropic.AsyncAnthropic.__init__")
            if hasattr(anthropic.AsyncAnthropic, "_mubit_learn_instrumented"):
                del anthropic.AsyncAnthropic._mubit_learn_instrumented
    except ImportError:
        pass

    # Restore Google GenAI
    try:
        import google.genai
        if "google.genai.Client.__init__" in _original_refs:
            google.genai.Client.__init__ = _original_refs.pop("google.genai.Client.__init__")
            if hasattr(google.genai.Client, "_mubit_learn_instrumented"):
                del google.genai.Client._mubit_learn_instrumented
    except ImportError:
        pass

    # Restore LiteLLM: remove our callbacks by identity and clear the flags so a
    # later init() re-registers cleanly (and tests don't leak global state).
    try:
        import litellm
        registered = _original_refs.pop("litellm.callbacks", [])
        if hasattr(litellm, "callbacks") and registered:
            litellm.callbacks[:] = [
                cb for cb in litellm.callbacks if cb not in registered
            ]
        for flag in ("_mubit_instrumented", "_mubit_learn_instrumented"):
            if hasattr(litellm, flag):
                delattr(litellm, flag)
    except ImportError:
        pass

    # Stop the shared ingest worker (flushes pending items).
    if _ingest_worker is not None:
        try:
            _ingest_worker.stop()
        except Exception:
            pass

    _original_refs.clear()
    _active_config = None
    _learn_client = None
    _lesson_cache = None
    _run_manager = None
    _ingest_worker = None


def get_lessons(
    query: str,
    *,
    session_id: Optional[str] = None,
    max_token_budget: Optional[int] = None,
    entry_types: Optional[List[str]] = None,
    sections: Optional[List[str]] = None,
) -> str:
    """Fetch relevant lessons as a context string. Works without any LLM library.

    This is the manual equivalent of the automatic lesson injection. Use it
    when making raw HTTP calls to LLM APIs or using unsupported libraries.

    Requires init() to have been called first.

    Args:
        query: The user question or topic to retrieve lessons for.
        session_id: Override session ID (defaults to current run's session).
        max_token_budget: Override token budget for context retrieval.
        entry_types: Override entry types to retrieve.
        sections: Override context sections to include.

    Returns:
        Pre-formatted context string, or empty string on failure.

    Raises:
        RuntimeError: If init() has not been called.
    """
    if _learn_client is None or _active_config is None or _run_manager is None:
        raise RuntimeError("mubit.learn.init() must be called before get_lessons()")

    sid = session_id or _run_manager.session_id
    budget = max_token_budget or _active_config.max_token_budget
    etypes = entry_types or _active_config.entry_types
    sects = sections or _active_config.context_sections

    # Check cache first
    if _lesson_cache is not None:
        cached = _lesson_cache.get(sid, query)
        if cached is not None:
            return cached

    try:
        context_block = _learn_client.get_context(
            session_id=sid,
            query=query,
            max_token_budget=budget,
            entry_types=etypes,
            sections=sects,
        )
        if _lesson_cache is not None:
            _lesson_cache.set(sid, query, context_block)
        return context_block
    except Exception as e:
        if _active_config.fail_open:
            logger.debug("mubit.learn.get_lessons() failed: %s", e)
            return ""
        raise


def get_lessons_with_ids(
    query: str,
    *,
    session_id: Optional[str] = None,
    max_token_budget: Optional[int] = None,
    entry_types: Optional[List[str]] = None,
    sections: Optional[List[str]] = None,
) -> "tuple[str, List[str]]":
    """Like :func:`get_lessons`, but also returns the entry IDs of the recalled
    sources so the call they inform can be attributed back to them.

    Pass the returned IDs to :func:`capture` (``entry_ids=...``) to credit the
    entries that contributed to the response. Returns ``("", [])`` on failure
    when ``fail_open`` is set.
    """
    if _learn_client is None or _active_config is None or _run_manager is None:
        raise RuntimeError(
            "mubit.learn.init() must be called before get_lessons_with_ids()"
        )

    sid = session_id or _run_manager.session_id
    budget = max_token_budget or _active_config.max_token_budget
    etypes = entry_types or _active_config.entry_types
    sects = sections or _active_config.context_sections

    try:
        block, ids = _learn_client.get_context_with_ids(
            session_id=sid,
            query=query,
            max_token_budget=budget,
            entry_types=etypes,
            sections=sects,
        )
        if _lesson_cache is not None:
            _lesson_cache.set(sid, query, block)
        return block, ids
    except Exception as e:
        if _active_config.fail_open:
            logger.debug("mubit.learn.get_lessons_with_ids() failed: %s", e)
            return "", []
        raise


def capture(
    messages: List[Dict[str, Any]],
    response: str,
    *,
    model: str = "",
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    user_id: Optional[str] = None,
    entry_ids: Optional[List[str]] = None,
    outcome: Optional[str] = None,
    signal: Optional[float] = None,
) -> None:
    """Ingest an LLM interaction. Works without any LLM library.

    Manual equivalent of the automatic trace capture, for raw HTTP calls or
    unsupported libraries. The interaction is always ingested + reflected on;
    it records an *outcome* (reinforcing ``entry_ids``) ONLY when you pass an
    explicit ``signal`` or ``outcome`` — capture never fabricates a success
    signal, since that would poison memory. To credit recalled entries with a
    real signal, prefer :func:`feedback`.

    Requires init() to have been called first.

    Args:
        messages: OpenAI-format messages list (dicts with 'role' and 'content').
        response: The assistant's response text.
        model: The LLM model name (for metadata).
        session_id: Override session ID (defaults to current run's session).
        agent_id: Override agent ID.
        user_id: Override user ID.
        entry_ids: Recalled entry IDs to credit — only when signal/outcome given.
        outcome: Explicit outcome string ("success"/"failure"); enables crediting.
        signal: Explicit reward in [-1, 1]; enables crediting.

    Raises:
        RuntimeError: If init() has not been called.
    """
    if _active_config is None or _run_manager is None:
        raise RuntimeError("mubit.learn.init() must be called before capture()")

    sid = session_id or _run_manager.session_id
    aid = agent_id or _active_config.agent_id
    uid = user_id or _active_config.user_id

    # Reinforce recalled entries ONLY with an explicitly-provided signal/outcome.
    # No fabricated success: HTTP-200 is not a memory-quality signal.
    if entry_ids and _learn_client is not None and (signal is not None or outcome is not None):
        sig = signal if signal is not None else (1.0 if (outcome or "success") == "success" else -1.0)
        sig = float(max(-1.0, min(1.0, sig)))
        out = outcome if outcome is not None else ("success" if sig >= 0 else "failure")
        try:
            _learn_client.record_outcome(
                sid, outcome=out, signal=sig, entry_ids=entry_ids, agent_id=aid
            )
        except Exception as e:
            logger.debug("mubit.learn.capture() attribution failed: %s", e)

    items = build_items(
        messages=messages,
        assistant_text=response,
        model=model or "unknown",
        latency_ms=0,
        capture=_active_config.capture,
        min_length=_active_config.min_length,
        user_id=uid,
    )

    if not items:
        return

    # Reuse the shared module worker (created in init()); fall back to a one-off
    # only if somehow absent.
    worker = _ingest_worker
    if worker is None:
        worker = IngestWorker(
            api_key=_active_config.api_key, endpoint=_active_config.endpoint
        )
        worker.start()
    worker.enqueue(sid, aid, items)

    # Also run auto-extraction if enabled
    if _active_config.auto_extract and response:
        from mubit.learn._extraction import extract_structured_items
        extracted = extract_structured_items(
            messages=messages,
            assistant_text=response,
            model=model or "unknown",
            user_id=uid,
        )
        if extracted:
            worker.enqueue(sid, aid, extracted)

    # Increment call count for reflection tracking
    _run_manager.increment()


def feedback(
    score: Optional[float] = None,
    *,
    good: Optional[bool] = None,
    entry_ids: Optional[List[str]] = None,
    response: Any = None,
    error: Optional[BaseException] = None,
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    verified_in_production: bool = False,
    rationale: str = "",
) -> None:
    """Credit the memories that helped (or hurt) — the one-line way to close the
    learning loop.

    The zero-code auto path injects lessons and reflects, but it never reinforces
    recalled entries on its own (HTTP success is not a quality signal). Call this
    after you know how a call went to apply a real reward to the entries that
    were recalled for it.

    Provide exactly one signal source:
    - ``good=True/False`` → +1.0 / -1.0 (thumbs up/down),
    - ``score=`` an explicit reward in [-1, 1],
    - or ``response=``/``error=`` to derive the signal from a provider result.

    ``entry_ids`` defaults to the entries recalled for the most recent call
    (tracked per run / on the current span). ``verified_in_production`` is a
    strong trust boost and is only ever set here, never automatically.

    Requires init() to have been called first.
    """
    if _learn_client is None or _run_manager is None or _active_config is None:
        raise RuntimeError("mubit.learn.init() must be called before feedback()")

    sid = session_id or _run_manager.session_id
    aid = agent_id or _active_config.agent_id

    # Resolve the entries to credit: explicit > current span > last recalled.
    ids = list(entry_ids) if entry_ids else None
    if ids is None:
        span = get_current_span()
        if span is not None and getattr(span, "recalled_entry_ids", None):
            ids = list(span.recalled_entry_ids)
        else:
            ids = _run_manager.last_recalled_ids()
    ids = [i for i in (ids or []) if i]
    if not ids:
        logger.debug("mubit.learn.feedback(): no recalled entry_ids to credit")
        return

    try:
        if score is None and good is None and (response is not None or error is not None):
            # Response-derived path (explicit opt-in): reuse the shared normalizer.
            attribute_outcome(
                _learn_client,
                sid,
                ids,
                response=response,
                error=error,
                agent_id=aid,
                rationale=rationale,
                verified_in_production=verified_in_production,
            )
            return

        if score is not None:
            signal = float(max(-1.0, min(1.0, score)))
        elif good is not None:
            signal = 1.0 if good else -1.0
        else:
            raise ValueError("feedback() requires one of: score, good, or response/error")

        outcome = "success" if signal >= 0 else "failure"
        _learn_client.record_outcome(
            sid,
            outcome=outcome,
            signal=signal,
            entry_ids=ids,
            agent_id=aid,
            rationale=rationale,
            verified_in_production=verified_in_production,
        )
    except ValueError:
        raise
    except Exception as e:
        if _active_config.fail_open:
            logger.warning("mubit.learn.feedback() failed (suppressed): %s", e)
            return
        raise


def wrap(client: Any, *, is_async: Optional[bool] = None) -> Any:
    """Explicitly wrap a single LLM client instance with mubit.learn.

    The robust alternative to global monkeypatching: because the concrete
    client instance is known here, async vs sync is decided reliably. Use it
    when you want to enrich one client without patching the library globally::

        import openai, mubit.learn
        mubit.learn.init(patch_globals=False)   # or just init()
        client = mubit.learn.wrap(openai.OpenAI())

    Requires init() to have been called first (it supplies config/cache/client).
    Returns the same instance, wrapped. Unknown client types are returned as-is.
    """
    if _active_config is None or _learn_client is None or _run_manager is None or _lesson_cache is None:
        raise RuntimeError("mubit.learn.init() must be called before wrap()")

    common = dict(
        learn_config=_active_config,
        lesson_cache=_lesson_cache,
        learn_client=_learn_client,
        run_manager=_run_manager,
        session_id=_run_manager.session_id,
        agent_id=_active_config.agent_id,
        user_id=_active_config.user_id,
        capture=_active_config.capture,
        min_length=_active_config.min_length,
        mubit_api_key=_active_config.api_key,
        mubit_endpoint=_active_config.endpoint,
    )

    if hasattr(client, "chat") and hasattr(client.chat, "completions"):
        from mubit.learn._openai_learn import wrap_openai_learn
        return wrap_openai_learn(client, is_async=is_async, **common)
    if hasattr(client, "messages") and hasattr(client.messages, "create"):
        from mubit.learn._anthropic_learn import wrap_anthropic_learn
        return wrap_anthropic_learn(client, is_async=is_async, **common)
    if hasattr(client, "models") and hasattr(client.models, "generate_content"):
        from mubit.learn._google_genai import wrap_google_genai_learn
        return wrap_google_genai_learn(client, **common)
    logger.debug("mubit.learn.wrap(): unrecognized client type %s", type(client))
    return client


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _enter_run(
    agent_id: Optional[str],
    session_id: Optional[str],
    auto_reflect: Optional[bool] = None,
    inject_lessons: Optional[bool] = None,
    max_token_budget: Optional[int] = None,
) -> RunManager:
    """Create a scoped RunManager and set up a Span."""
    if _active_config is None or _learn_client is None:
        raise RuntimeError("mubit.learn.init() must be called before starting a run")

    # Build a per-run config with overrides
    cfg = LearnConfig(
        api_key=_active_config.api_key,
        endpoint=_active_config.endpoint,
        agent_id=agent_id or _active_config.agent_id,
        user_id=_active_config.user_id,
        session_id=session_id,
        inject_lessons=inject_lessons if inject_lessons is not None else _active_config.inject_lessons,
        injection_position=_active_config.injection_position,
        max_token_budget=max_token_budget if max_token_budget is not None else _active_config.max_token_budget,
        entry_types=_active_config.entry_types,
        context_sections=_active_config.context_sections,
        capture=_active_config.capture,
        min_length=_active_config.min_length,
        auto_reflect=auto_reflect if auto_reflect is not None else _active_config.auto_reflect,
        reflect_after_n_calls=_active_config.reflect_after_n_calls,
        cache_ttl_seconds=_active_config.cache_ttl_seconds,
        cache_max_entries=_active_config.cache_max_entries,
        fail_open=_active_config.fail_open,
    )

    rm = RunManager(cfg, _learn_client)

    # Push a span so auto-capture wrappers pick up the session_id
    parent = get_current_span()
    span = Span(
        parent_id=parent.trace_id if parent else None,
        name=f"learn-run-{rm.session_id}",
        agent_id=cfg.agent_id,
        session_id=rm.session_id,
        user_id=cfg.user_id,
    )
    set_current_span(span)

    return rm


def _shutdown() -> None:
    """Atexit handler: end the global run (fires reflection) and flush ingest."""
    if _run_manager and not _run_manager._ended:
        _run_manager.end()
    if _ingest_worker is not None:
        try:
            _ingest_worker.flush()
        except Exception:
            pass


def _patch_openai(config, cache, client, run_manager):
    """Monkey-patch OpenAI classes to use learn wrappers."""
    try:
        import openai
        from mubit.learn._openai_learn import wrap_openai_learn

        if not getattr(openai.OpenAI, "_mubit_learn_instrumented", False):
            # Uninstrument auto module first if it was active
            if getattr(openai.OpenAI, "_mubit_instrumented", False):
                from mubit.auto._instrument import uninstrument as auto_uninstrument
                auto_uninstrument()

            _original_refs["openai.OpenAI.__init__"] = openai.OpenAI.__init__

            def patched_init(self, *args, **kwargs):
                _original_refs["openai.OpenAI.__init__"](self, *args, **kwargs)
                wrap_openai_learn(
                    self,
                    learn_config=config,
                    lesson_cache=cache,
                    learn_client=client,
                    run_manager=run_manager,
                    session_id=run_manager.session_id,
                    agent_id=config.agent_id,
                    user_id=config.user_id,
                    capture=config.capture,
                    min_length=config.min_length,
                    mubit_api_key=config.api_key,
                    mubit_endpoint=config.endpoint,
                    is_async=False,
                )

            openai.OpenAI.__init__ = patched_init
            openai.OpenAI._mubit_learn_instrumented = True

        if not getattr(openai.AsyncOpenAI, "_mubit_learn_instrumented", False):
            _original_refs["openai.AsyncOpenAI.__init__"] = openai.AsyncOpenAI.__init__

            def patched_async_init(self, *args, **kwargs):
                _original_refs["openai.AsyncOpenAI.__init__"](self, *args, **kwargs)
                wrap_openai_learn(
                    self,
                    learn_config=config,
                    lesson_cache=cache,
                    learn_client=client,
                    run_manager=run_manager,
                    session_id=run_manager.session_id,
                    agent_id=config.agent_id,
                    user_id=config.user_id,
                    capture=config.capture,
                    min_length=config.min_length,
                    mubit_api_key=config.api_key,
                    mubit_endpoint=config.endpoint,
                    is_async=True,
                )

            openai.AsyncOpenAI.__init__ = patched_async_init
            openai.AsyncOpenAI._mubit_learn_instrumented = True

    except ImportError:
        pass


def _patch_anthropic(config, cache, client, run_manager):
    """Monkey-patch Anthropic classes to use learn wrappers."""
    try:
        import anthropic
        from mubit.learn._anthropic_learn import wrap_anthropic_learn

        if not getattr(anthropic.Anthropic, "_mubit_learn_instrumented", False):
            if getattr(anthropic.Anthropic, "_mubit_instrumented", False):
                from mubit.auto._instrument import uninstrument as auto_uninstrument
                auto_uninstrument()

            _original_refs["anthropic.Anthropic.__init__"] = anthropic.Anthropic.__init__

            def patched_init(self, *args, **kwargs):
                _original_refs["anthropic.Anthropic.__init__"](self, *args, **kwargs)
                wrap_anthropic_learn(
                    self,
                    learn_config=config,
                    lesson_cache=cache,
                    learn_client=client,
                    run_manager=run_manager,
                    session_id=run_manager.session_id,
                    agent_id=config.agent_id,
                    user_id=config.user_id,
                    capture=config.capture,
                    min_length=config.min_length,
                    mubit_api_key=config.api_key,
                    mubit_endpoint=config.endpoint,
                    is_async=False,
                )

            anthropic.Anthropic.__init__ = patched_init
            anthropic.Anthropic._mubit_learn_instrumented = True

        if not getattr(anthropic.AsyncAnthropic, "_mubit_learn_instrumented", False):
            _original_refs["anthropic.AsyncAnthropic.__init__"] = anthropic.AsyncAnthropic.__init__

            def patched_async_init(self, *args, **kwargs):
                _original_refs["anthropic.AsyncAnthropic.__init__"](self, *args, **kwargs)
                wrap_anthropic_learn(
                    self,
                    learn_config=config,
                    lesson_cache=cache,
                    learn_client=client,
                    run_manager=run_manager,
                    session_id=run_manager.session_id,
                    agent_id=config.agent_id,
                    user_id=config.user_id,
                    capture=config.capture,
                    min_length=config.min_length,
                    mubit_api_key=config.api_key,
                    mubit_endpoint=config.endpoint,
                    is_async=True,
                )

            anthropic.AsyncAnthropic.__init__ = patched_async_init
            anthropic.AsyncAnthropic._mubit_learn_instrumented = True

    except ImportError:
        pass


def _patch_litellm(config, cache, client, run_manager):
    """Add learn callback to litellm."""
    try:
        import litellm
        from mubit.auto._litellm import MubitLiteLLMLogger
        from mubit.learn._litellm_learn import MubitLearnLiteLLMCallback

        # Track appended callbacks by identity so uninstrument() can remove them.
        registered = _original_refs.setdefault("litellm.callbacks", [])

        # Add auto-capture logger if not already present
        if not getattr(litellm, "_mubit_instrumented", False):
            auto_cb = MubitLiteLLMLogger(
                session_id=run_manager.session_id,
                agent_id=config.agent_id,
                user_id=config.user_id,
                capture=config.capture,
                min_length=config.min_length,
                mubit_api_key=config.api_key,
                mubit_endpoint=config.endpoint,
            )
            if hasattr(litellm, "callbacks"):
                litellm.callbacks.append(auto_cb)
                registered.append(auto_cb)
                litellm._mubit_instrumented = True

        # Add learn callback
        if not getattr(litellm, "_mubit_learn_instrumented", False):
            learn_cb = MubitLearnLiteLLMCallback(config, cache, client, run_manager)
            if hasattr(litellm, "callbacks"):
                litellm.callbacks.append(learn_cb)
                registered.append(learn_cb)
                litellm._mubit_learn_instrumented = True

    except ImportError:
        pass


def _patch_google_genai(config, cache, client, run_manager):
    """Monkey-patch Google GenAI Client to use learn wrappers."""
    try:
        import google.genai
        from mubit.learn._google_genai import wrap_google_genai_learn

        if not getattr(google.genai.Client, "_mubit_learn_instrumented", False):
            _original_refs["google.genai.Client.__init__"] = google.genai.Client.__init__

            def patched_init(self, *args, **kwargs):
                _original_refs["google.genai.Client.__init__"](self, *args, **kwargs)
                wrap_google_genai_learn(
                    self,
                    learn_config=config,
                    lesson_cache=cache,
                    learn_client=client,
                    run_manager=run_manager,
                    session_id=run_manager.session_id,
                    agent_id=config.agent_id,
                    user_id=config.user_id,
                    capture=config.capture,
                    min_length=config.min_length,
                    mubit_api_key=config.api_key,
                    mubit_endpoint=config.endpoint,
                )

            google.genai.Client.__init__ = patched_init
            google.genai.Client._mubit_learn_instrumented = True

    except ImportError:
        pass
