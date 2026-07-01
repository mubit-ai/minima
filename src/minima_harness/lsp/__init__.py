"""LSP code-intelligence support for the harness (experimental, opt-in).

Where ``grep`` finds *text*, the ``lsp`` tool finds *meaning* — the definition a name
binds to, every reference to it, hover docs, or a file's symbol outline — by driving a
real language server. v1 supports Python only (via ``pylsp``) and is gated behind the
``MINIMA_EXPERIMENTAL_LSP`` env flag.

Public surface:
- :func:`lsp_enabled` — whether the experimental ``lsp`` tool is turned on.
- The JSON-RPC client (:mod:`.client`) and warm-server manager (:mod:`.manager`) live in
  submodules; import them directly to avoid pulling subprocess machinery into this flag check.
"""

from __future__ import annotations

import os

ENV_FLAG = "MINIMA_EXPERIMENTAL_LSP"
_TRUTHY = {"1", "true", "yes", "on"}


def lsp_enabled() -> bool:
    """True when ``MINIMA_EXPERIMENTAL_LSP`` is set to a truthy value."""
    return os.environ.get(ENV_FLAG, "").strip().lower() in _TRUTHY
