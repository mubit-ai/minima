"""
MuBit Auto-Capture Module.

Provides automated LLM input/output capture for MAS learning loops.
"""

from mubit.auto._openai import wrap_openai
from mubit.auto._anthropic import wrap_anthropic
from mubit.auto._instrument import instrument, uninstrument
from mubit.auto._context import no_capture

__all__ = [
    "wrap_openai",
    "wrap_anthropic",
    "instrument",
    "uninstrument",
    "no_capture",
]
