"""Model-independent aggregation for the continuous voiceprint gate."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

Label = Literal["target", "non_target", "overlap"]


@dataclass(frozen=True)
class EvaluationTrial:
    label: Label
    target_present: bool
    scores: tuple[float, ...]
    decision_latency_s: float

    def accepted(self, threshold: float) -> bool:
        return any(score >= threshold for score in self.scores)


@dataclass(frozen=True)
class EvaluationSummary:
    threshold: float
    target_frr: float
    non_target_far: float
    target_present_overlap_recall: float
    target_absent_overlap_far: float
    acceptance_latency_p50_s: float
    acceptance_latency_p95_s: float
    acceptance_latency_p99_s: float


def _slice(trials: list[EvaluationTrial], label: Label, target_present: bool | None) -> list[EvaluationTrial]:
    selected = [
        trial
        for trial in trials
        if trial.label == label and (target_present is None or trial.target_present is target_present)
    ]
    if not selected:
        presence = "" if target_present is None else " target-present" if target_present else " target-absent"
        raise ValueError(f"evaluation requires at least one {label}{presence} trial")
    return selected


def evaluate_trials(trials: list[EvaluationTrial], threshold: float) -> EvaluationSummary:
    if not 0.0 < threshold <= 1.0:
        raise ValueError(f"threshold must be in (0, 1], got {threshold}")

    target = _slice(trials, "target", None)
    non_target = _slice(trials, "non_target", None)
    overlap_present = _slice(trials, "overlap", True)
    overlap_absent = _slice(trials, "overlap", False)

    target_frr = sum(not trial.accepted(threshold) for trial in target) / len(target)
    non_target_far = sum(trial.accepted(threshold) for trial in non_target) / len(non_target)
    overlap_recall = sum(trial.accepted(threshold) for trial in overlap_present) / len(overlap_present)
    overlap_far = sum(trial.accepted(threshold) for trial in overlap_absent) / len(overlap_absent)

    accepted_latencies = [trial.decision_latency_s for trial in trials if trial.accepted(threshold)]

    def percentile(percent: float) -> float:
        if not accepted_latencies:
            return 0.0
        return float(np.percentile(accepted_latencies, percent))

    return EvaluationSummary(
        threshold=threshold,
        target_frr=target_frr,
        non_target_far=non_target_far,
        target_present_overlap_recall=overlap_recall,
        target_absent_overlap_far=overlap_far,
        acceptance_latency_p50_s=percentile(50),
        acceptance_latency_p95_s=percentile(95),
        acceptance_latency_p99_s=percentile(99),
    )
