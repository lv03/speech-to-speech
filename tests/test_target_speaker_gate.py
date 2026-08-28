from __future__ import annotations

import threading
import time

import numpy as np

from speech_to_speech.security.speaker_gate import GateStatus, TargetSpeakerGate
from speech_to_speech.security.voiceprint import VoiceprintMatch


class FakeVerifier:
    def __init__(self, scores: list[float]) -> None:
        self.scores = iter(scores)
        self.windows: list[np.ndarray] = []

    def verify(self, audio: np.ndarray) -> VoiceprintMatch:
        self.windows.append(audio.copy())
        return VoiceprintMatch(next(self.scores), np.ones(192, dtype=np.float32))


def _wait_decision(gate: TargetSpeakerGate, audio: np.ndarray, active_ms: float):
    deadline = time.monotonic() + 1.0
    decision = gate.observe(audio, active_speech_ms=active_ms)
    while decision.status is GateStatus.PENDING and time.monotonic() < deadline:
        time.sleep(0.005)
        decision = gate.observe(audio, active_speech_ms=active_ms)
    return decision


def test_gate_waits_for_first_check_and_accepts_matching_window():
    verifier = FakeVerifier([0.9])
    gate = TargetSpeakerGate(verifier, threshold=0.75)
    gate.start_segment()

    assert gate.observe(np.ones(12799, dtype=np.float32), active_speech_ms=799).status is GateStatus.PENDING
    decision = _wait_decision(gate, np.ones(12800, dtype=np.float32), 800)

    assert decision.status is GateStatus.ACCEPTED
    assert decision.checks == 1
    assert len(verifier.windows[0]) == 12800
    gate.close()


def test_gate_retries_latest_window_and_accepts_later_target():
    verifier = FakeVerifier([0.2, 0.9])
    gate = TargetSpeakerGate(verifier, threshold=0.75)
    gate.start_segment()

    first_audio = np.arange(12800, dtype=np.float32)
    assert _wait_decision(gate, first_audio, 800).status is GateStatus.PENDING
    second_audio = np.arange(20800, dtype=np.float32)
    decision = _wait_decision(gate, second_audio, 1300)

    assert decision.status is GateStatus.ACCEPTED
    assert decision.checks == 2
    assert (verifier.windows[-1] == np.arange(20800, dtype=np.float32)).all()
    gate.close()


def test_gate_rejects_final_non_target_segment():
    verifier = FakeVerifier([0.1])
    gate = TargetSpeakerGate(verifier, threshold=0.75)
    gate.start_segment()

    decision = gate.finish(np.ones(16000, dtype=np.float32))

    assert decision.status is GateStatus.REJECTED
    assert decision.reason == "below_threshold"
    gate.close()


def test_gate_rejects_audio_shorter_than_model_minimum():
    gate = TargetSpeakerGate(FakeVerifier([]), threshold=0.75)
    gate.start_segment()

    decision = gate.finish(np.ones(7999, dtype=np.float32))

    assert decision.status is GateStatus.REJECTED
    assert decision.reason == "too_short"
    gate.close()


def test_reset_invalidates_late_result():
    release = threading.Event()

    class BlockingVerifier:
        def verify(self, _audio: np.ndarray) -> VoiceprintMatch:
            release.wait(1.0)
            return VoiceprintMatch(0.99, np.ones(192, dtype=np.float32))

    gate = TargetSpeakerGate(BlockingVerifier(), threshold=0.75)
    gate.start_segment()
    gate.observe(np.ones(12800, dtype=np.float32), active_speech_ms=800)
    gate.reset()
    gate.start_segment()
    release.set()
    time.sleep(0.02)

    assert gate.observe(np.ones(1000, dtype=np.float32), active_speech_ms=50).status is GateStatus.PENDING
    gate.close()


def test_gate_submits_only_one_concurrent_check():
    active = 0
    peak = 0
    guard = threading.Lock()

    class SlowVerifier:
        def verify(self, _audio: np.ndarray) -> VoiceprintMatch:
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
            time.sleep(0.03)
            with guard:
                active -= 1
            return VoiceprintMatch(0.1, np.ones(192, dtype=np.float32))

    gate = TargetSpeakerGate(SlowVerifier(), threshold=0.75)
    gate.start_segment()
    gate.observe(np.ones(12800, dtype=np.float32), active_speech_ms=800)
    for ms in (1300, 1800, 2300):
        gate.observe(np.ones(30000, dtype=np.float32), active_speech_ms=ms)

    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        decision = gate.observe(np.ones(30000, dtype=np.float32), active_speech_ms=3000)
        if decision.status is not GateStatus.PENDING:
            break
        time.sleep(0.005)

    assert peak == 1
    gate.close()


def test_verify_exception_rejects_segment():
    class BoomVerifier:
        def verify(self, _audio: np.ndarray) -> VoiceprintMatch:
            raise RuntimeError("boom")

    gate = TargetSpeakerGate(BoomVerifier(), threshold=0.75)
    gate.start_segment()

    decision = _wait_decision(gate, np.ones(12800, dtype=np.float32), 800)

    assert decision.status is GateStatus.REJECTED
    assert decision.reason == "verification_error"
    gate.close()


def test_final_wait_times_out_when_verifier_blocks():
    release = threading.Event()

    class BlockingVerifier:
        def verify(self, _audio: np.ndarray) -> VoiceprintMatch:
            release.wait(5.0)
            return VoiceprintMatch(0.99, np.ones(192, dtype=np.float32))

    gate = TargetSpeakerGate(BlockingVerifier(), threshold=0.75, final_wait_s=0.01)
    gate.start_segment()
    gate.observe(np.ones(12800, dtype=np.float32), active_speech_ms=800)

    decision = gate.finish(np.ones(16000, dtype=np.float32))

    assert decision.status is GateStatus.REJECTED
    assert decision.reason == "verification_timeout"
    release.set()
    gate.close()


def test_acceptance_is_permanent():
    verifier = FakeVerifier([0.9, 0.1])
    gate = TargetSpeakerGate(verifier, threshold=0.75)
    gate.start_segment()

    assert _wait_decision(gate, np.ones(12800, dtype=np.float32), 800).status is GateStatus.ACCEPTED
    assert gate.observe(np.ones(20000, dtype=np.float32), active_speech_ms=1200).status is GateStatus.ACCEPTED
    assert len(verifier.windows) == 1
    assert gate.finish(np.ones(20000, dtype=np.float32)).status is GateStatus.ACCEPTED
    gate.close()
