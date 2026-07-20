"""The hand-maintained TS schema mirrors must not drift from the Python wire truth.

CLAUDE.md mandates every schema field lands in packages/tui/src/minima/schemas.ts;
this test makes the invariant mechanical instead of manual (it had already drifted
once before this existed). The standalone TS SDK (packages/sdk) carries a second
copy of the mirror, pinned here the same way.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from minima.schemas.feedback import FeedbackRequest, FeedbackResponse
from minima.schemas.recommend import RecommendRequest

_ROOT = Path(__file__).resolve().parents[2]
_MIRRORS = {
    "tui": _ROOT / "packages" / "tui" / "src" / "minima" / "schemas.ts",
    "sdk": _ROOT / "packages" / "sdk" / "src" / "schemas.ts",
}

# Diagnostics deliberately not mirrored (explain-only payload weight, no TS consumer).
_EXEMPT = {
    "RecommendRequest": set(),
    "FeedbackRequest": set(),
    "FeedbackResponse": set(),
}


def _ts_interface_fields(mirror: Path, name: str) -> set[str]:
    src = mirror.read_text(encoding="utf-8")
    m = re.search(rf"export interface {name} \{{(.*?)\}}", src, re.DOTALL)
    assert m, f"interface {name} missing from {mirror}"
    return set(re.findall(r"^\s*([a-z_][a-z0-9_]*)\??:", m.group(1), re.MULTILINE))


@pytest.mark.parametrize(
    ("model", "interface"),
    [
        (RecommendRequest, "RecommendRequest"),
        (FeedbackRequest, "FeedbackRequest"),
        (FeedbackResponse, "FeedbackResponse"),
    ],
)
@pytest.mark.parametrize("mirror_name", sorted(_MIRRORS))
def test_ts_mirror_covers_every_wire_field(model, interface, mirror_name):
    py_fields = set(model.model_fields) - _EXEMPT.get(interface, set())
    ts_fields = _ts_interface_fields(_MIRRORS[mirror_name], interface)
    missing = py_fields - ts_fields
    assert not missing, (
        f"{mirror_name} schemas.ts {interface} is missing wire fields {sorted(missing)} — "
        "the TS mirror drifted from the Python source of truth"
    )
