"""
MuBit Auto-Capture Instrumenter.

Global monkey-patching for convenience (Tier 2 interception).
"""

from typing import Optional, Any
from mubit.auto._worker import IngestWorker

_original_refs = {}


def instrument(
    session_id: str = "",
    agent_id: str = "auto",
    user_id: str = "",
    capture: str = "all",
    min_length: int = 0,
    mubit_api_key: Optional[str] = None,
    mubit_endpoint: Optional[str] = None,
) -> None:
    """
    Monkey-patch known LLM libraries to auto-capture into MuBit.
    
    Patches:
    - openai.OpenAI / AsyncOpenAI
    - anthropic.Anthropic / AsyncAnthropic
    - litellm.callbacks (adds logger)
    """
    # Start worker eagerly
    worker = IngestWorker(api_key=mubit_api_key, endpoint=mubit_endpoint)
    worker.start()

    # 1. Patch OpenAI
    try:
        import openai
        from mubit.auto._openai import wrap_openai

        # Check if already patched to avoid recursion
        if not getattr(openai.OpenAI, "_mubit_instrumented", False):
            _original_refs["openai.OpenAI.__init__"] = openai.OpenAI.__init__
            
            def patched_openai_init(self, *args, **kwargs):
                _original_refs["openai.OpenAI.__init__"](self, *args, **kwargs)
                wrap_openai(
                    self,
                    session_id=session_id,
                    agent_id=agent_id,
                    user_id=user_id,
                    capture=capture,
                    min_length=min_length,
                    mubit_api_key=mubit_api_key,
                    mubit_endpoint=mubit_endpoint,
                )
            
            openai.OpenAI.__init__ = patched_openai_init
            openai.OpenAI._mubit_instrumented = True

        if not getattr(openai.AsyncOpenAI, "_mubit_instrumented", False):
            _original_refs["openai.AsyncOpenAI.__init__"] = openai.AsyncOpenAI.__init__
            
            def patched_async_openai_init(self, *args, **kwargs):
                _original_refs["openai.AsyncOpenAI.__init__"](self, *args, **kwargs)
                wrap_openai(
                    self,
                    session_id=session_id,
                    agent_id=agent_id,
                    user_id=user_id,
                    capture=capture,
                    min_length=min_length,
                    mubit_api_key=mubit_api_key,
                    mubit_endpoint=mubit_endpoint,
                )
                
            openai.AsyncOpenAI.__init__ = patched_async_openai_init
            openai.AsyncOpenAI._mubit_instrumented = True

    except ImportError:
        pass

    # 2. Patch Anthropic
    try:
        import anthropic
        from mubit.auto._anthropic import wrap_anthropic

        if not getattr(anthropic.Anthropic, "_mubit_instrumented", False):
            _original_refs["anthropic.Anthropic.__init__"] = anthropic.Anthropic.__init__
            
            def patched_anthropic_init(self, *args, **kwargs):
                _original_refs["anthropic.Anthropic.__init__"](self, *args, **kwargs)
                wrap_anthropic(
                    self,
                    session_id=session_id,
                    agent_id=agent_id,
                    user_id=user_id,
                    capture=capture,
                    min_length=min_length,
                    mubit_api_key=mubit_api_key,
                    mubit_endpoint=mubit_endpoint,
                )
            
            anthropic.Anthropic.__init__ = patched_anthropic_init
            anthropic.Anthropic._mubit_instrumented = True

        if not getattr(anthropic.AsyncAnthropic, "_mubit_instrumented", False):
            _original_refs["anthropic.AsyncAnthropic.__init__"] = anthropic.AsyncAnthropic.__init__
            
            def patched_async_anthropic_init(self, *args, **kwargs):
                _original_refs["anthropic.AsyncAnthropic.__init__"](self, *args, **kwargs)
                wrap_anthropic(
                    self,
                    session_id=session_id,
                    agent_id=agent_id,
                    user_id=user_id,
                    capture=capture,
                    min_length=min_length,
                    mubit_api_key=mubit_api_key,
                    mubit_endpoint=mubit_endpoint,
                )
                
            anthropic.AsyncAnthropic.__init__ = patched_async_anthropic_init
            anthropic.AsyncAnthropic._mubit_instrumented = True

    except ImportError:
        pass

    # 3. Patch LiteLLM
    try:
        import litellm
        from mubit.auto._litellm import MubitLiteLLMLogger
        
        # Check if already added
        if not getattr(litellm, "_mubit_instrumented", False):
            cb = MubitLiteLLMLogger(
                session_id=session_id,
                agent_id=agent_id,
                user_id=user_id,
                capture=capture,
                min_length=min_length,
                mubit_api_key=mubit_api_key,
                mubit_endpoint=mubit_endpoint,
            )
            # litellm.callbacks is a list
            if hasattr(litellm, "callbacks"):
                litellm.callbacks.append(cb)
                litellm._mubit_instrumented = True
    except ImportError:
        pass


def uninstrument() -> None:
    """Restore original library behavior."""
    # Restore OpenAI
    try:
        import openai
        if "openai.OpenAI.__init__" in _original_refs:
            openai.OpenAI.__init__ = _original_refs["openai.OpenAI.__init__"]
            if hasattr(openai.OpenAI, "_mubit_instrumented"):
                del openai.OpenAI._mubit_instrumented
                
        if "openai.AsyncOpenAI.__init__" in _original_refs:
            openai.AsyncOpenAI.__init__ = _original_refs["openai.AsyncOpenAI.__init__"]
            if hasattr(openai.AsyncOpenAI, "_mubit_instrumented"):
                del openai.AsyncOpenAI._mubit_instrumented
    except ImportError:
        pass

    # Restore Anthropic
    try:
        import anthropic
        if "anthropic.Anthropic.__init__" in _original_refs:
            anthropic.Anthropic.__init__ = _original_refs["anthropic.Anthropic.__init__"]
            if hasattr(anthropic.Anthropic, "_mubit_instrumented"):
                del anthropic.Anthropic._mubit_instrumented
        
        if "anthropic.AsyncAnthropic.__init__" in _original_refs:
            anthropic.AsyncAnthropic.__init__ = _original_refs["anthropic.AsyncAnthropic.__init__"]
            if hasattr(anthropic.AsyncAnthropic, "_mubit_instrumented"):
                del anthropic.AsyncAnthropic._mubit_instrumented
    except ImportError:
        pass
    
    # LiteLLM (cannot easily remove callback without reference, best effort)
    # We don't remove it, just stop future additions via _mubit_instrumented flag reset?
    # Or we can scan callbacks.
    try:
        import litellm
        if hasattr(litellm, "_mubit_instrumented"):
            del litellm._mubit_instrumented
            # Note: The logger instance remains in callbacks list
    except ImportError:
        pass
    
    _original_refs.clear()
