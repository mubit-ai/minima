"""The hand-maintained TS schema mirror must not drift from the Python wire truth.

CLAUDE.md mandates every schema field lands in packages/tui/src/minima/schemas.ts;
this test makes the invariant mechanical instead of manual (it had already drifted
once before this existed).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from minima.schemas.feedback import FeedbackRequest, FeedbackResponse
from minima.schemas.recommend import RecommendRequest

_TS = Path(__file__).resolve().parents[2] / "packages" / "tui" / "src" / "minima" / "schemas.ts"

# Diagnostics deliberately not mirrored (explain-only payload weight, no TS consumer).
_EXEMPT = {
    "RecommendRequest": set(),
    "FeedbackRequest": set(),
    "FeedbackResponse": set(),
}


def _ts_interface_fields(name: str) -> set[str]:
    src = _TS.read_text(encoding="utf-8")
    m = re.search(rf"export interface {name} \{{(.*?)\}}", src, re.DOTALL)
    assert m, f"interface {name} missing from schemas.ts"
    return set(re.findall(r"^\s*([a-z_][a-z0-9_]*)\??:", m.group(1), re.MULTILINE))


@pytest.mark.parametrize(
    ("model", "interface"),
    [
        (RecommendRequest, "RecommendRequest"),
        (FeedbackRequest, "FeedbackRequest"),
        (FeedbackResponse, "FeedbackResponse"),
    ],
)
def test_ts_mirror_covers_every_wire_field(model, interface):
    py_fields = set(model.model_fields) - _EXEMPT.get(interface, set())
    ts_fields = _ts_interface_fields(interface)
    missing = py_fields - ts_fields
    assert not missing, (
        f"schemas.ts {interface} is missing wire fields {sorted(missing)} — "
        "the TS mirror drifted from the Python source of truth"
    )
