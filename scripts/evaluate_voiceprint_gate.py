"""Offline score harness for the continuous target-speaker gate."""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from speech_to_speech.security.evaluation import EvaluationTrial, evaluate_trials
from speech_to_speech.security.voiceprint import SAMPLE_RATE, VoiceprintVerifier


def _window_list(value: str) -> list[float]:
    parts = [part.strip() for part in value.split(",") if part.strip()]
    if not parts:
        raise argparse.ArgumentTypeError("window-ms must contain at least one value")
    return [float(part) for part in parts]


def load_audio(path: str) -> np.ndarray:
    data, sample_rate = sf.read(path, always_2d=False, dtype="float32")
    if data.ndim != 1:
        raise ValueError(f"{path}: multi-channel audio is not supported")
    if sample_rate == SAMPLE_RATE:
        return np.asarray(data, dtype=np.float32)
    divisor = int(np.gcd(SAMPLE_RATE, int(sample_rate)))
    up = SAMPLE_RATE // divisor
    down = int(sample_rate) // divisor
    return np.asarray(resample_poly(data, up, down), dtype=np.float32)


def score_windows(
    verifier: VoiceprintVerifier,
    audio: np.ndarray,
    window_ms: float,
    hop_ms: float,
) -> tuple[list[float], float]:
    window_samples = int(window_ms * SAMPLE_RATE / 1000)
    hop_samples = max(1, int(hop_ms * SAMPLE_RATE / 1000))
    if len(audio) < window_samples:
        positions = [len(audio)]
    else:
        positions = list(range(window_samples, len(audio) + 1, hop_samples))
        if positions[-1] != len(audio):
            positions.append(len(audio))

    started = time.monotonic()
    scores: list[float] = []
    for end in positions:
        window = audio[max(0, end - window_samples) : end]
        scores.append(verifier.verify(window).score)
    return scores, time.monotonic() - started


def _trial_from_row(
    verifier: VoiceprintVerifier,
    row: dict[str, Any],
    window_ms: float,
    hop_ms: float,
) -> tuple[EvaluationTrial, dict[str, Any]]:
    audio = load_audio(row["audio_filepath"])
    scores, latency_s = score_windows(verifier, audio, window_ms, hop_ms)
    trial = EvaluationTrial(
        label=row["label"],
        target_present=bool(row["target_present"]),
        scores=tuple(scores),
        decision_latency_s=latency_s,
    )
    detail = {
        "audio_filepath": row["audio_filepath"],
        "label": row["label"],
        "target_present": bool(row["target_present"]),
        "max_score": max(scores) if scores else None,
        "decision_latency_s": latency_s,
    }
    return trial, detail


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the continuous voiceprint gate on labeled audio.")
    parser.add_argument("--profile", type=Path, required=True, help="Conversation voiceprint profile path.")
    parser.add_argument("--manifest", type=Path, required=True, help="JSONL manifest of labeled audio files.")
    parser.add_argument(
        "--threshold",
        type=float,
        action="append",
        required=True,
        help="Acceptance threshold to evaluate (repeatable).",
    )
    parser.add_argument(
        "--window-ms",
        type=_window_list,
        default=[800, 1200, 1600, 2000],
        help="Comma-separated verification window lengths in milliseconds.",
    )
    parser.add_argument("--hop-ms", type=float, default=500, help="Sliding window hop in milliseconds.")
    parser.add_argument("--output", type=Path, required=True, help="JSON report output path.")
    args = parser.parse_args()

    verifier = VoiceprintVerifier.load(args.profile, require_conversation=True)
    verifier.preload()

    rows: list[dict[str, Any]] = []
    for line in args.manifest.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))

    results: list[dict[str, Any]] = []
    for window_ms in args.window_ms:
        trials: list[EvaluationTrial] = []
        details: list[dict[str, Any]] = []
        for row in rows:
            trial, detail = _trial_from_row(verifier, row, window_ms, args.hop_ms)
            trials.append(trial)
            details.append(detail)
        thresholds = [
            {"threshold": threshold, "summary": asdict(evaluate_trials(trials, threshold))}
            for threshold in args.threshold
        ]
        results.append({"window_ms": window_ms, "thresholds": thresholds, "trials": details})

    report = {
        "profile": str(args.profile),
        "model": verifier.profile.model_name,
        "protocol": verifier.profile.enrollment_protocol,
        "hop_ms": args.hop_ms,
        "results": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
