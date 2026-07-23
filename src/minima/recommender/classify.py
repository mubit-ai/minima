"""Heuristic task classification: feature vector, type, and difficulty.

Cheap and deterministic. Caller-supplied ``task_type``/``difficulty`` always win.
Neighbor votes can refine a heuristic result the caller didn't override (and the
difficulty is re-inferred coherently with the refined type), but no LLM is
consulted here. Callers gate WHEN to pass votes (the engine only does so for
``other``/low-confidence classifications).
"""

from __future__ import annotations

import re
import time
from collections.abc import Iterable
from dataclasses import dataclass, field

from minima.schemas.common import Difficulty, TaskInput, TaskType
from minima.schemas.recommend import ClassificationProfile, ClassificationRuleProfile

# Identity of the active assignment function, stamped on decision rows so mixed-classifier
# windows stay sliceable. A learned classifier derives this from its artifact hash.
CLASSIFIER_ID = "regex-v1"


@dataclass(slots=True, frozen=True)
class TaskFeatureVector:
    reasoning: float = 0.0
    code: float = 0.0
    structured_output: float = 0.0
    creativity: float = 0.0
    expected_input_output_length: float = 0.0
    language: float = 0.0
    tool_use: float = 0.0


@dataclass(slots=True, frozen=True)
class ClassificationEstimate:
    features: TaskFeatureVector
    task_type: TaskType
    difficulty: Difficulty
    uncertainty: float
    confidence: float
    neighbor_support: float = 0.0
    neighbor_count: int = 0
    profile: ClassificationProfile | None = None


@dataclass(slots=True, frozen=True)
class _NeighborVoteEstimate:
    task_type: TaskType
    features: TaskFeatureVector
    uncertainty: float
    neighbor_support: float
    neighbor_count: int


@dataclass(slots=True, frozen=True)
class NeighborClassificationEstimate:
    task_type: TaskType
    neighbor_support: float
    neighbor_count: int


@dataclass(slots=True)
class _ClassificationProfiler:
    started: float = field(default_factory=time.monotonic)
    marks: list[tuple[str, float]] = field(default_factory=list)

    def mark(self, name: str) -> None:
        self.marks.append((name, (time.monotonic() - self.started) * 1000.0))

    def as_dict(self) -> dict[str, float]:
        result: dict[str, float] = {}
        prev = 0.0
        for name, total in self.marks:
            result[name] = round(total - prev, 3)
            prev = total
        result["total"] = round((time.monotonic() - self.started) * 1000.0, 3)
        return result


@dataclass(slots=True, frozen=True)
class _FeatureRule:
    task_type: TaskType
    pattern: re.Pattern[str]
    values: TaskFeatureVector


_FEATURE_RULES: tuple[_FeatureRule, ...] = (
    _FeatureRule(
        TaskType.code,
        re.compile(
            r"```|\bdef \b|\bclass \b|\bfunction\b|\bimport \b|\bSELECT \b|regex|stack ?trace"
            r"|\btraceback\b|compile|refactor|implement|debug"
            # coding-agent vocabulary: bugs, tests, builds, repos, tooling (a live coding
            # prompt classified summarization/trivial because none of these matched)
            r"|\bbugs?\b|\bfix(es|ed|ing)? (the |a |this |my |our |your |it\b)|\bfix it\b"
            r"|\b(failing|unit|integration|broken) tests?\b|\btests? (pass|fail|suite)\b"
            r"|\brun the tests\b|\bpytest\b|\bnpm (test|run)\b|\blint(er)?\b|\btype-?check"
            r"|\bcodebase\b|\brepo(sitory)?\b|\bgit (commit|branch|diff|rebase)\b"
            r"|\bcompil(er|ation) error\b|\bexit code\b"
            # web-building vocabulary: build-intent verb + web artifact noun, plus bare
            # strong signals (a live "build me a website" prompt classified other/easy)
            r"|\b(build|create|make|develop)\b[^.?!]{0,60}?"
            r"\b(web ?site|web ?pages?|web ?app|webapp|landing page|front-?end)\b"
            r"|\bhtml\b|\bcss\b|\bfront-?end\b"
            # file-path/extension mentions are strong code signals
            r"|\b[\w/.-]+\.(py|ts|tsx|js|jsx|go|rs|java|rb|cpp|cs|sh|sql|yaml|yml|toml|json"
            r"|html|css|scss|sass|less|vue|svelte)\b",
            re.I,
        ),
        TaskFeatureVector(
            reasoning=0.35,
            code=1.0,
            structured_output=0.2,
            expected_input_output_length=0.5,
            tool_use=0.15,
        ),
    ),
    _FeatureRule(
        TaskType.translation,
        re.compile(
            r"\btranslate\b|\bin (french|spanish|german|chinese|japanese|hindi)\b|\bto (french|spanish|german)\b",
            re.I,
        ),
        TaskFeatureVector(language=1.0, expected_input_output_length=0.45),
    ),
    _FeatureRule(
        TaskType.summarization,
        re.compile(r"\bsummari[sz]e\b|\btl;?dr\b|\bsummary\b|\bcondense\b|\bin brief\b", re.I),
        TaskFeatureVector(structured_output=0.3, expected_input_output_length=0.85),
    ),
    _FeatureRule(
        TaskType.extraction,
        re.compile(
            r"\bextract\b|\bparse\b|\bpull out\b|\blist all\b|\bfind all\b|\bjson schema\b|\bfields?\b.*\bfrom\b",
            re.I,
        ),
        TaskFeatureVector(structured_output=1.0, expected_input_output_length=0.35),
    ),
    _FeatureRule(
        TaskType.classification,
        re.compile(
            r"\bclassif|\bcategori[sz]e\b|\blabel\b|\bsentiment\b|\bwhich (category|class|label)\b|\btrue or false\b",
            re.I,
        ),
        TaskFeatureVector(structured_output=0.9, expected_input_output_length=0.2),
    ),
    _FeatureRule(
        TaskType.tool_use,
        re.compile(r"\bcall the\b|\buse the tool\b|\bfunction call\b|\btool[_ ]?call\b|\bapi call\b", re.I),
        TaskFeatureVector(tool_use=1.0, structured_output=0.25, expected_input_output_length=0.25),
    ),
    _FeatureRule(
        TaskType.rag,
        re.compile(
            r"\bbased on the (following|context|document)\b|\baccording to the\b|\bcontext:\b|\bgiven the passage\b",
            re.I,
        ),
        TaskFeatureVector(reasoning=0.35, structured_output=0.35, expected_input_output_length=0.7),
    ),
    _FeatureRule(
        TaskType.creative,
        re.compile(r"\bwrite a (story|poem|song|essay)\b|\bcreative\b|\bimagine\b|\bbrainstorm\b", re.I),
        TaskFeatureVector(creativity=1.0, expected_input_output_length=0.55),
    ),
    _FeatureRule(
        TaskType.reasoning,
        re.compile(
            r"\bprove\b|\bcalculate\b|\bsolve\b|\bequation\b|\bstep[- ]by[- ]step\b|\breason(ing)?\b|\bderive\b|\bwhy (does|is|are)\b"
            # design/architecture prompts are reasoning-heavy even without math verbs
            r"|\bdesign an?\b|\barchitect(ure)?\b|\btrade-?offs?\b|\balgorithm\b|\bdata structures?\b"
            r"|\block-free\b|\bconcurren(t|cy)\b|\bdistributed\b|\bconsensus\b"
            r"|\brace condition\b|\bdeadlock\b|\bmemory[- ]ordering\b|\binvariants?\b",
            re.I,
        ),
        TaskFeatureVector(reasoning=1.0, structured_output=0.2, expected_input_output_length=0.4),
    ),
    _FeatureRule(
        TaskType.qa,
        re.compile(r"^\s*(what|who|when|where|why|how|which|is|are|does|can)\b|\?\s*$", re.I),
        TaskFeatureVector(reasoning=0.55, expected_input_output_length=0.2),
    ),
)

_STRUCTURED_OUTPUT_MARKERS = re.compile(
    r"\b(json|schema|yaml|csv|table|bullet|list all|find all|extract|parse|fields?\b.*\bfrom\b|structured output)\b",
    re.I,
)

_SHORT_OUTPUT_MARKERS = re.compile(r"\b(concise|brief|short answer|one paragraph|one sentence|3 bullets)\b", re.I)
_LONG_OUTPUT_MARKERS = re.compile(
    r"\b(detailed|comprehensive|thorough|step[- ]by[- ]step|explain in detail|full list)\b", re.I
)
_COMPLEXITY_MARKERS = re.compile(
    r"\b(and then|after that|must|ensure|constraint|optimi[sz]e|edge case|step \d|\d\.\s"
    # systems-hardness cues: concurrency/distribution/compat push real difficulty up
    r"|lock-free|concurren(t|cy)|thread-?safe|race condition|deadlock|distributed"
    r"|memory[- ]ordering|multi-tenant|SLAs?|backwards?[- ]compatib|migration|atomic)\b",
    re.I,
)
# Build-scope markers: a generative verb aimed at a substantial artifact. Word count
# alone reads "build me a website" as trivial; the requested SCOPE is what's large.
_BUILD_SCOPE_MARKERS = re.compile(
    r"\b(build|create|make|write|develop)\b[^.?!]{0,60}?"
    r"\b(web ?site|web ?pages?|web ?app|webapp|landing page|apps?|applications?|games?"
    r"|dashboards?|services?|apis?|clis?|tools?|bots?)\b",
    re.I,
)

_FEATURE_NAMES = (
    "reasoning",
    "code",
    "structured_output",
    "creativity",
    "expected_input_output_length",
    "language",
    "tool_use",
)

_TASK_PROTOTYPES: dict[TaskType, TaskFeatureVector] = {
    TaskType.code: TaskFeatureVector(
        reasoning=0.35,
        code=1.0,
        structured_output=0.2,
        expected_input_output_length=0.5,
        tool_use=0.15,
    ),
    TaskType.summarization: TaskFeatureVector(structured_output=0.3, expected_input_output_length=0.85),
    TaskType.extraction: TaskFeatureVector(structured_output=1.0, expected_input_output_length=0.35),
    TaskType.qa: TaskFeatureVector(reasoning=0.55, expected_input_output_length=0.2),
    TaskType.reasoning: TaskFeatureVector(reasoning=1.0, structured_output=0.2, expected_input_output_length=0.4),
    TaskType.classification: TaskFeatureVector(structured_output=0.9, expected_input_output_length=0.2),
    TaskType.translation: TaskFeatureVector(language=1.0, expected_input_output_length=0.45),
    TaskType.creative: TaskFeatureVector(creativity=1.0, expected_input_output_length=0.55),
    TaskType.rag: TaskFeatureVector(reasoning=0.35, structured_output=0.35, expected_input_output_length=0.7),
    TaskType.tool_use: TaskFeatureVector(tool_use=1.0, structured_output=0.25, expected_input_output_length=0.25),
    TaskType.other: TaskFeatureVector(),
}

# Task types that tend to need more capability for the same text length.
_HARD_TYPES = {TaskType.code, TaskType.reasoning}
_EASY_TYPES = {
    TaskType.classification,
    TaskType.extraction,
    TaskType.summarization,
    TaskType.translation,
}

_ORDER = [
    Difficulty.trivial,
    Difficulty.easy,
    Difficulty.medium,
    Difficulty.hard,
    Difficulty.expert,
]


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _vector_items(vector: TaskFeatureVector) -> tuple[tuple[str, float], ...]:
    return tuple((name, getattr(vector, name)) for name in _FEATURE_NAMES)


def _vector_to_dict(vector: TaskFeatureVector) -> dict[str, float]:
    return {name: getattr(vector, name) for name in _FEATURE_NAMES}


def _vector_from_values(values: dict[str, float]) -> TaskFeatureVector:
    return TaskFeatureVector(**{name: _clamp01(values.get(name, 0.0)) for name in _FEATURE_NAMES})


def _blend_vectors(primary: TaskFeatureVector, secondary: TaskFeatureVector, weight: float) -> TaskFeatureVector:
    weight = _clamp01(weight)
    blended: dict[str, float] = {}
    for name, primary_value in _vector_items(primary):
        blended[name] = (primary_value * (1.0 - weight)) + (getattr(secondary, name) * weight)
    return _vector_from_values(blended)


def _classify_text(
    text: str,
    *,
    expected_input_tokens: int | None = None,
    expected_output_tokens: int | None = None,
) -> tuple[TaskFeatureVector, tuple[ClassificationRuleProfile, ...], TaskType, str | None]:
    values = dict.fromkeys(_FEATURE_NAMES, 0.0)
    rule_checks: list[ClassificationRuleProfile] = []
    # Strongest signal wins the TASK TYPE; rule-list order only breaks ties. First-match
    # let one incidental verb ("...then summarize the fix") outvote several domain cues
    # (bug/tests/pytest) — observed live pricing a multi-turn coding task like a one-line
    # summary. The FEATURE VECTOR still accumulates across every matched rule (unchanged).
    heuristic_task_type = TaskType.other
    selected_rule: str | None = None
    best_hits = 0
    for rule in _FEATURE_RULES:
        hits = len(rule.pattern.findall(text))
        # Question FORM is one weak signal, not two: a leading interrogative plus a
        # trailing "?" must not outvote a single real domain cue.
        if rule.task_type is TaskType.qa:
            hits = min(hits, 1)
        matched = hits > 0
        if matched:
            if hits > best_hits:
                heuristic_task_type = rule.task_type
                selected_rule = rule.task_type.value
                best_hits = hits
            for name, value in _vector_items(rule.values):
                values[name] = max(values[name], value)
        rule_checks.append(
            ClassificationRuleProfile(
                task_type=rule.task_type,
                pattern=rule.pattern.pattern,
                matched=matched,
                feature_boosts=_vector_to_dict(rule.values),
            )
        )

    features = _vector_from_values(values)
    reasoning = features.reasoning
    code = features.code
    structured_output = features.structured_output
    creativity = features.creativity
    language = features.language
    tool_use = features.tool_use
    expected_input_output_length = _normalize_length_score(
        text, expected_input_tokens, expected_output_tokens
    )
    if _STRUCTURED_OUTPUT_MARKERS.search(text):
        structured_output = max(structured_output, 1.0)
    if reasoning and re.search(r"\b(why|how|what|which|explain)\b", text, re.I):
        reasoning = min(1.0, reasoning + 0.15)
    if structured_output and re.search(r"\b(json|yaml|csv|table|bullet|list)\b", text, re.I):
        structured_output = min(1.0, structured_output + 0.1)
    return (
        TaskFeatureVector(
            reasoning=reasoning,
            code=code,
            structured_output=structured_output,
            creativity=creativity,
            expected_input_output_length=expected_input_output_length,
            language=language,
            tool_use=tool_use,
        ),
        tuple(rule_checks),
        heuristic_task_type,
        selected_rule,
    )


def _feature_vector_from_rules(rules: Iterable[_FeatureRule]) -> TaskFeatureVector:
    values = dict.fromkeys(_FEATURE_NAMES, 0.0)
    for rule in rules:
        for name, value in _vector_items(rule.values):
            values[name] = max(values[name], value)
    return _vector_from_values(values)


def _normalize_length_score(text: str, expected_input_tokens: int | None, expected_output_tokens: int | None) -> float:
    expected_tokens = (expected_input_tokens or 0) + (expected_output_tokens or 0)
    if expected_tokens > 0:
        score = expected_tokens / 4000.0
    else:
        score = len(text.split()) / 240.0
    if _LONG_OUTPUT_MARKERS.search(text):
        score = max(score, 0.75)
    if _SHORT_OUTPUT_MARKERS.search(text):
        score = min(score, 0.35)
    if _COMPLEXITY_MARKERS.search(text):
        score = min(1.0, score + 0.1)
    return _clamp01(score)


def extract_feature_vector(
    text: str, *, expected_input_tokens: int | None = None, expected_output_tokens: int | None = None
) -> TaskFeatureVector:
    features, _, _, _ = _classify_text(
        text,
        expected_input_tokens=expected_input_tokens,
        expected_output_tokens=expected_output_tokens,
    )
    return features


def _estimate_uncertainty(
    features: TaskFeatureVector, task_type: TaskType, *, neighbor_support: float = 0.0
) -> float:
    values = sorted((getattr(features, name) for name in _FEATURE_NAMES), reverse=True)
    top = values[0] if values else 0.0
    second = values[1] if len(values) > 1 else 0.0
    margin = max(0.0, top - second)
    base = 1.0 - _clamp01(margin)
    if task_type == TaskType.other:
        base = max(base, 0.85)
    if top <= 0.0:
        base = 0.95
    if neighbor_support > 0.0:
        base = min(base, 1.0 - _clamp01(neighbor_support) + 0.1)
    return _clamp01(base)


def _classification_confidence(
    task: TaskInput,
    task_type: TaskType,
    heuristic_task_type: TaskType,
    uncertainty: float,
    selected_rule: str | None = None,
) -> float:
    confidence = 1.0 - _clamp01(uncertainty)
    if task.task_type is not None:
        confidence += 0.12
        if task.task_type == task_type:
            confidence += 0.08
    if task_type in _EASY_TYPES:
        confidence += 0.06
    if task_type == TaskType.other:
        confidence -= 0.1
    elif heuristic_task_type == task_type:
        confidence += 0.04
    if task.task_type is None and task_type in _EASY_TYPES:
        confidence += 0.03
    if (
        selected_rule is not None
        and task_type in _EASY_TYPES
        and task.task_type is not None
        and task.task_type == task_type
    ):
        confidence = max(confidence, 0.85)
    elif selected_rule is not None and task_type in _EASY_TYPES:
        confidence = max(confidence, 0.75)
    return _clamp01(confidence)


def _neighbor_classification_estimate(
    votes: Iterable[tuple[str, float]], *, min_neighbors: int = 2, min_share: float = 0.5
) -> _NeighborVoteEstimate | None:
    weighted: dict[str, float] = {}
    counts: dict[str, int] = {}
    total = 0.0
    for tt, weight in votes:
        if not tt or tt == TaskType.other.value:
            continue
        try:
            task_type = TaskType(tt)
        except ValueError:
            continue
        weight = max(0.0, weight)
        if weight <= 0.0:
            continue
        weighted[task_type.value] = weighted.get(task_type.value, 0.0) + weight
        counts[task_type.value] = counts.get(task_type.value, 0) + 1
        total += weight
    if total <= 0.0:
        return None
    best = max(weighted, key=weighted.__getitem__)
    support = weighted[best] / total
    if counts[best] < min_neighbors or support < min_share:
        return None
    neighbor_values = dict.fromkeys(_FEATURE_NAMES, 0.0)
    for task_type_name, weight in weighted.items():
        prototype = _TASK_PROTOTYPES[TaskType(task_type_name)]
        for name, value in _vector_items(prototype):
            neighbor_values[name] += value * weight
    neighbor_features = _vector_from_values({name: value / total for name, value in neighbor_values.items()})
    uncertainty = _estimate_uncertainty(neighbor_features, TaskType(best), neighbor_support=support)
    return _NeighborVoteEstimate(
        task_type=TaskType(best),
        features=neighbor_features,
        uncertainty=uncertainty,
        neighbor_support=support,
        neighbor_count=counts[best],
    )


def infer_task_type(text: str) -> TaskType:
    _, _, task_type, _ = _classify_text(text)
    return task_type


def infer_difficulty(text: str, task_type: TaskType) -> Difficulty:
    words = len(text.split())
    if words < 40:
        base = 1  # easy
    elif words < 150:
        base = 2  # medium
    elif words < 400:
        base = 3  # hard
    else:
        base = 4  # expert

    if _BUILD_SCOPE_MARKERS.search(text):
        base = max(base, 2)  # build-scope floor: a short ask for a big artifact is not easy

    if len(_COMPLEXITY_MARKERS.findall(text)) >= 2:
        base += 1  # multiple multi-step / constraint markers

    if task_type in _HARD_TYPES:
        base += 1
    elif task_type in _EASY_TYPES:
        base -= 1

    index = max(0, min(len(_ORDER) - 1, base))
    return _ORDER[index]


def classify_details(
    task: TaskInput, *, neighbor_votes: Iterable[tuple[str, float]] | None = None
) -> ClassificationEstimate:
    profiler = _ClassificationProfiler()
    profiler.mark("start")
    features, rule_checks, heuristic_task_type, selected_rule = _classify_text(
        task.task,
        expected_input_tokens=task.expected_input_tokens,
        expected_output_tokens=task.expected_output_tokens,
    )
    profiler.mark("classify_text")
    neighbor_support = 0.0
    neighbor_count = 0
    task_type = task.task_type or heuristic_task_type
    task_type_source = "caller" if task.task_type is not None else "heuristic"
    if neighbor_votes is not None:
        neighbor_estimate = _neighbor_classification_estimate(neighbor_votes)
        if neighbor_estimate is not None:
            features = _blend_vectors(features, neighbor_estimate.features, 0.35)
            neighbor_support = neighbor_estimate.neighbor_support
            neighbor_count = neighbor_estimate.neighbor_count
            if (
                task.task_type is None
                and neighbor_estimate.task_type != TaskType.other
                and neighbor_estimate.task_type != task_type
            ):
                task_type = neighbor_estimate.task_type
                task_type_source = "neighbor_vote"
        profiler.mark("neighbor_vote")
    profiler.mark("difficulty")
    difficulty = task.difficulty or infer_difficulty(task.task, task_type)
    uncertainty = _estimate_uncertainty(features, task_type, neighbor_support=neighbor_support)
    confidence = _classification_confidence(
        task, task_type, heuristic_task_type, uncertainty, selected_rule=selected_rule
    )
    easy_route = task_type in _EASY_TYPES and confidence >= 0.72 and selected_rule is not None
    profile = ClassificationProfile(
        task_type_source=task_type_source,
        difficulty_source="caller" if task.difficulty is not None else "heuristic",
        caller_task_type=task.task_type,
        caller_difficulty=task.difficulty,
        heuristic_task_type=heuristic_task_type,
        heuristic_difficulty=infer_difficulty(task.task, heuristic_task_type),
        final_task_type=task_type,
        final_difficulty=difficulty,
        selected_rule=selected_rule,
        rule_checks=list(rule_checks),
        extracted_features=_vector_to_dict(features),
        uncertainty=uncertainty,
        confidence=confidence,
        easy_route=easy_route,
        neighbor_support=neighbor_support,
        neighbor_count=neighbor_count,
        timings_ms=profiler.as_dict(),
    )
    return ClassificationEstimate(
        features=features,
        task_type=task_type,
        difficulty=difficulty,
        uncertainty=uncertainty,
        confidence=confidence,
        neighbor_support=neighbor_support,
        neighbor_count=neighbor_count,
        profile=profile,
    )


def classify(
    task: TaskInput, *, neighbor_votes: Iterable[tuple[str, float]] | None = None
) -> tuple[TaskType, Difficulty]:
    details = classify_details(task, neighbor_votes=neighbor_votes)
    return details.task_type, details.difficulty


def classify_from_neighbors(
    votes: list[tuple[str, float]], *, min_neighbors: int = 2, min_share: float = 0.5
) -> TaskType | None:
    """Disambiguate an `other` classification from ANN-recalled semantic neighbors.

    ``votes`` is ``(neighbor_task_type, similarity)`` over recalled outcomes. Returns the
    similarity-weighted plurality type when it is non-`other`, has >= ``min_neighbors``
    supporters, and holds >= ``min_share`` of the weighted vote; else None. This is the
    free semantic fallback for prompts the regex can't place.
    """
    estimate = _neighbor_classification_estimate(votes, min_neighbors=min_neighbors, min_share=min_share)
    if estimate is None or estimate.task_type == TaskType.other:
        return None
    return estimate.task_type


def classify_from_neighbors_details(
    votes: list[tuple[str, float]], *, min_neighbors: int = 2, min_share: float = 0.5
) -> NeighborClassificationEstimate | None:
    estimate = _neighbor_classification_estimate(votes, min_neighbors=min_neighbors, min_share=min_share)
    if estimate is None or estimate.task_type == TaskType.other:
        return None
    return NeighborClassificationEstimate(
        task_type=estimate.task_type,
        neighbor_support=estimate.neighbor_support,
        neighbor_count=estimate.neighbor_count,
    )
