"""Backward-compat shim. LessonCache moved to mubit._cache."""

from mubit._cache import LessonCache

__all__ = ["LessonCache"]
