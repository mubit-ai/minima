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

from minima.schemas.capabilities import CapabilitiesResponse
from minima.schemas.common import Constraints, DecisionBasis, Difficulty, OutcomeLabel, TaskInput
from minima.schemas.common import TaskType as TaskTypeEnum
from minima.schemas.feedback import FeedbackRequest, FeedbackResponse, StepOutcome
from minima.schemas.insight import (
    DiagnoseRequest,
    DiagnoseResponse,
    FailureLesson,
    MemoryHealthResponse,
    PosteriorReset,
)
from minima.schemas.models_catalog import ModelCard, ModelsResponse
from minima.schemas.recommend import (
    ClassificationProfile,
    ClassificationRuleProfile,
    EvidenceRef,
    RankedModel,
    RecommendRequest,
    RecommendResponse,
)
from minima.schemas.savings import CalibrationResponse, PolicyValueResponse, SavingsResponse
from minima.schemas.strategies import StrategiesResponse, Strategy
from minima.schemas.workflow import WorkflowRequest, WorkflowResponse, WorkflowStep

_ROOT = Path(__file__).resolve().parents[2]
_MIRRORS = {
    "tui": _ROOT / "packages" / "tui" / "src" / "minima" / "schemas.ts",
    "sdk": _ROOT / "packages" / "sdk" / "src" / "schemas.ts",
}

# Diagnostics deliberately not mirrored (explain-only payload weight, no TS consumer).
_EXEMPT = {
    "RecommendRequest": set(),
    "RecommendResponse": set(),
    "ClassificationProfile": set(),
    "FeedbackRequest": set(),
    "FeedbackResponse": set(),
}


def _ts_interface_fields(mirror: Path, name: str) -> set[str]:
    """Field names declared in a TS interface.

    The body runs to the first closing brace in column 0, not the first closing brace of
    any kind — an interface with an inline object type (WorkflowResponse.steps) would
    otherwise truncate to the fields above it and report the rest as drift. Keys inside an
    inline object are not at line start, so they never register as fields of their own.
    """
    src = mirror.read_text(encoding="utf-8")
    m = re.search(rf"^export interface {name} \{{$(.*?)^\}}$", src, re.DOTALL | re.MULTILINE)
    assert m, f"interface {name} missing from {mirror}"
    return set(re.findall(r"^\s*([a-z_][a-z0-9_]*)\??:", m.group(1), re.MULTILINE))


@pytest.mark.parametrize(
    ("model", "interface"),
    [
        (RecommendRequest, "RecommendRequest"),
        (RecommendResponse, "RecommendResponse"),
        (ClassificationProfile, "ClassificationProfile"),
        (FeedbackRequest, "FeedbackRequest"),
        (FeedbackResponse, "FeedbackResponse"),
        # Reachable from the five above, or from an endpoint the TS clients call. The TS
        # PolicyEstimate/ChallengerEstimate/RegretReport have no Pydantic counterpart --
        # they mirror metrics/ope.py dataclasses -- so they stay off this list.
        (Constraints, "Constraints"),
        (TaskInput, "TaskInput"),
        (EvidenceRef, "EvidenceRef"),
        (RankedModel, "RankedModel"),
        (ClassificationRuleProfile, "ClassificationRuleProfile"),
        (StepOutcome, "StepOutcome"),
        (ModelCard, "ModelCard"),
        (ModelsResponse, "ModelsResponse"),
        (WorkflowStep, "WorkflowStep"),
        (WorkflowRequest, "WorkflowRequest"),
        (WorkflowResponse, "WorkflowResponse"),
        (SavingsResponse, "SavingsResponse"),
        (CalibrationResponse, "CalibrationResponse"),
        (PolicyValueResponse, "PolicyValueResponse"),
        (StrategiesResponse, "StrategiesResponse"),
        (Strategy, "Strategy"),
        (DiagnoseRequest, "DiagnoseRequest"),
        (FailureLesson, "FailureLesson"),
        (DiagnoseResponse, "DiagnoseResponse"),
        (PosteriorReset, "PosteriorReset"),
        (MemoryHealthResponse, "MemoryHealthResponse"),
        (CapabilitiesResponse, "CapabilitiesResponse"),
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


def _ts_const_values(mirror: Path, name: str) -> list[str]:
    src = mirror.read_text(encoding="utf-8")
    m = re.search(rf"export const {name} = \[(.*?)\] as const;", src, re.DOTALL)
    assert m, f"const {name} missing from {mirror}"
    return re.findall(r'"([^"]+)"', m.group(1))


@pytest.mark.parametrize(
    ("enum", "const"),
    [
        (TaskTypeEnum, "TASK_TYPES"),
        (Difficulty, "DIFFICULTIES"),
        (OutcomeLabel, "OUTCOME_LABELS"),
        (DecisionBasis, "DECISION_BASES"),
    ],
)
@pytest.mark.parametrize("mirror_name", sorted(_MIRRORS))
def test_ts_mirror_enum_values_match(enum, const, mirror_name):
    """A value added to a StrEnum must land in both TS copies.

    The field-name test above cannot see this: an enum widens without any interface
    changing, so a new task_type would classify server-side and be unrepresentable in
    either client. Order matters too — these consts are the client-side display order.
    """
    assert _ts_const_values(_MIRRORS[mirror_name], const) == [m.value for m in enum], (
        f"{mirror_name} schemas.ts {const} drifted from {enum.__name__}"
    )
