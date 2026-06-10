"""Backward-compat shim. PromptCache moved to mubit._cache."""

from mubit._cache import PromptCache

__all__ = ["PromptCache"]
