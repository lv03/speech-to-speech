from __future__ import annotations

import pytest

from speech_to_speech.security.evaluation import EvaluationTrial, evaluate_trials


def test_evaluate_trials_reports_product_gate_metrics():
    trials = [
        EvaluationTrial("target", True, (0.8,), 0.10),
        EvaluationTrial("target", True, (0.4,), 0.12),
        EvaluationTrial("non_target", False, (0.9,), 0.08),
        EvaluationTrial("non_target", False, (0.2,), 0.09),
        EvaluationTrial("overlap", True, (0.3, 0.85), 0.20),
        EvaluationTrial("overlap", False, (0.1, 0.2), 0.18),
    ]

    summary = evaluate_trials(trials, threshold=0.75)

    assert summary.target_frr == 0.5
    assert summary.non_target_far == 0.5
    assert summary.target_present_overlap_recall == 1.0
    assert summary.target_absent_overlap_far == 0.0
    assert summary.acceptance_latency_p95_s >= 0.10


@pytest.mark.parametrize(
    ("drop_label", "drop_target_present"),
    [
        ("target", None),
        ("non_target", None),
        ("overlap", True),
        ("overlap", False),
    ],
)
def test_evaluate_trials_requires_every_slice(drop_label, drop_target_present):
    trials = [
        EvaluationTrial("target", True, (0.8,), 0.10),
        EvaluationTrial("non_target", False, (0.2,), 0.09),
        EvaluationTrial("overlap", True, (0.85,), 0.20),
        EvaluationTrial("overlap", False, (0.1,), 0.18),
    ]
    kept = [
        trial
        for trial in trials
        if not (trial.label == drop_label and (drop_target_present is None or trial.target_present == drop_target_present))
    ]

    with pytest.raises(ValueError):
        evaluate_trials(kept, threshold=0.75)
