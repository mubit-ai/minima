"""Adapters that plug Minima's recommend->feedback loop into existing harnesses.

Each adapter is dependency-light: the target framework is imported lazily so the
package works without it installed. Install the frameworks to use (and test) them:
``uv sync --extra adapters`` or ``pip install litellm openhands-sdk``.
"""
