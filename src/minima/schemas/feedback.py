"""Schemas for the feedback / learning-loop endpoint."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from minima.schemas.common import OutcomeLabel

MAX_SIGNAL_KEYS = 16
_SIGNAL_KEY_RE = re.compile(r"^[a-z_]{1,32}$")


class StepOutcome(BaseModel):
    """One plan step's objective verdict, relayed to Mubit as a process reward.

    Dense per-step signals give reflection finer-grained failure attribution than the
    turn-level outcome and feed Mubit's workflow induction (reusable procedure entries
    distilled from repeatedly-credited step traces). Send only deterministic verdicts
    (the harness's red->green gate results) — never model self-assessment.
    """

    step_id: str = Field(..., min_length=1)
    step_name: str | None = None
    outcome: OutcomeLabel
    signal: float | None = Field(
        None, ge=-1, le=1, description="reinforcement signal; derived from outcome when omitted"
    )
    rationale: str | None = None
    directive_hint: str | None = Field(
        None, description="corrective directive for future attempts at this step"
    )


class FeedbackRequest(BaseModel):
    recommendation_id: str = Field(..., min_length=1)
    chosen_model_id: str = Field(..., min_length=1, description="model actually run (may differ)")
    outcome: OutcomeLabel
    quality_score: float | None = Field(None, ge=0, le=1, description="caller-supplied; no judge")
    input_tokens: int | None = Field(None, ge=0)
    output_tokens: int | None = Field(None, ge=0)
    actual_cost_usd: float | None = Field(None, ge=0)
    latency_ms: int | None = Field(None, ge=0)
    iterations: int | None = Field(
        None, ge=0, description="agent loop turns to resolution (token-yield signal)"
    )
    evidence_source: Literal["gate", "judge", "human", "none"] | None = Field(
        None,
        description=(
            "Provenance of the quality signal. gate = deterministic verification "
            "(red->green check; the only origin that may claim verified-in-production); "
            "judge = LLM judge; human = caller-asserted; none = unjudged — the outcome "
            "enters cost/latency telemetry only, never the success aggregate, "
            "reinforcement, or calibration. When omitted, derived from the legacy "
            "judged/verified_in_production flags."
        ),
    )
    error_cause: Literal["infra", "quality"] | None = Field(
        None,
        description=(
            "For outcome=failure: infra = provider/tooling fault (429/5xx/timeout) — "
            "telemetry only, never recorded as a model-quality signal; quality = the "
            "model genuinely produced a bad result."
        ),
    )
    verified_in_production: bool = Field(
        False, description="DEPRECATED: send evidence_source='gate' instead."
    )
    judged: bool | None = Field(
        None,
        description=(
            "DEPRECATED: send evidence_source instead. True maps to 'judge', "
            "False to 'none'; omitted (old SDK clients) maps to 'human' "
            "(caller-asserted outcome)."
        ),
    )
    chosen_effort: str | None = Field(
        None,
        description=(
            "reasoning-effort tier the model ran at (e.g. low/medium/high). Recorded "
            "on the outcome record and decision log so (model x effort) arms can be "
            "learned; not yet a routing dimension."
        ),
    )
    parent_rec_id: str | None = Field(
        None,
        description=(
            "rec_id of the immediately preceding rung in a recovery-ladder chain. "
            "Lets the server assemble same-task preference pairs (failed parent vs "
            "succeeding child) and learn escalation deferral — absent outside recovery."
        ),
    )
    escalation_reason: Literal["gate_failed", "judge_failed", "transient", "hard_error"] | None = (
        Field(
            None,
            description=(
                "Why the parent rung failed (sent alongside parent_rec_id): the ladder "
                "cause that triggered this re-route."
            ),
        )
    )
    provider_model_snapshot: str | None = Field(
        None,
        description=(
            "Exact model identifier the provider reported serving (e.g. a dated "
            "snapshot), as opposed to the requested alias — the observable key for "
            "version-churn posterior resets."
        ),
    )
    label_propensity: float | None = Field(
        None,
        gt=0,
        le=1,
        description=(
            "Probability this turn was selected for labeling (judge sampling rate at "
            "selection time; 1.0 for deterministic gate labels). Required for unbiased "
            "OPE/calibration once labeling is non-uniform."
        ),
    )
    signals: dict[str, bool] | None = Field(
        None,
        description=(
            "Implicit-signal map (max 16 keys, keys ^[a-z_]{1,32}$) — the program's ONE "
            "signals block; new signal kinds are new keys here, never new fields. "
            "Omit-absent semantics: a key is present only when that signal was actually "
            "observed; true and false are BOTH observed outcomes (false = observed and "
            "did not fire). An absent key means not-observed — senders must never "
            "default an unobserved key to false, and consumers must treat absent as "
            "abstain, not as false. Stored on the outcome record and consumed only by "
            "the (opt-in) weak-supervision label model — never by evidence provenance. "
            "Reserved keys: retried (the recovery ladder re-attempted this prompt), "
            "user_corrected (the user rejected/steered a gate this turn), diff_reverted "
            "(the turn's diff was later reverted), session_continued (the user kept "
            "prompting after this turn), observer_flagged (an observer agent flagged "
            "the turn)."
        ),
    )
    notes: str | None = None
    idempotency_key: str | None = None
    step_outcomes: list[StepOutcome] = Field(
        default_factory=list,
        description=(
            "Per-step objective verdicts from the run (gate results), relayed to memory "
            "as process rewards. Independent of the turn-level label: steps carry their "
            "own provenance, so they are recorded even when the turn is unlabeled."
        ),
    )

    @field_validator("signals")
    @classmethod
    def _validate_signals(cls, v: dict[str, bool] | None) -> dict[str, bool] | None:
        if v is None:
            return v
        if len(v) > MAX_SIGNAL_KEYS:
            raise ValueError(f"signals: at most {MAX_SIGNAL_KEYS} keys allowed")
        for key in v:
            if not _SIGNAL_KEY_RE.match(key):
                raise ValueError(f"signals: invalid key {key!r} (must match ^[a-z_]{{1,32}}$)")
        return v


class FeedbackResponse(BaseModel):
    accepted: bool
    record_id: str | None = None
    reinforced_entry_ids: list[str] = Field(default_factory=list)
    updated_confidence: float | None = None
    reflection_triggered: bool = False
    lesson_promoted: bool = False
    step_outcomes_recorded: int = 0
    warnings: list[str] = Field(default_factory=list)
