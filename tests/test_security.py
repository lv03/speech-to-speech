"""Tests for the wake-word + voiceprint security stage."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np
import pytest

import speech_to_speech.security.gate as gate_module
from speech_to_speech.security.voiceprint import Voiceprint, VoiceprintProfile


def _chunk(seconds: float = 0.032, value: float = 0.01) -> bytes:
    samples = int(seconds * 16000)
    return (np.ones(samples, dtype=np.int16) * int(value * 32767)).tobytes()


class _FakeDetector:
    """Detector stub: returns wake audio for the first N chunks (or a given call)."""

    def __init__(self, detections: int = 0, fire_on_call: int | None = None, **kwargs):
        self.remaining = detections
        self.fire_on_call = fire_on_call
        self.calls = 0
        self.reset_calls = 0

    def process(self, samples: np.ndarray) -> np.ndarray | None:
        self.calls += 1
        fired = False
        if self.fire_on_call is not None and self.calls == self.fire_on_call:
            fired = True
        elif self.remaining > 0:
            self.remaining -= 1
            fired = True
        return np.ones(16000, dtype=np.float32) if fired else None

    def reset(self) -> None:
        self.reset_calls += 1


class _FakeVoiceprint:
    def __init__(self, **kwargs):
        pass

    @property
    def model(self) -> object:
        return object()

    def embed(self, audio: np.ndarray) -> np.ndarray:
        return np.ones(192, dtype=np.float32)


class _FakeProfile:
    def __init__(self, score: float):
        self._score = score
        self.model_name = "fake"
        self.embedding = np.ones(192, dtype=np.float32)

    def score(self, embedding: np.ndarray) -> float:
        return self._score

    def save(self, path) -> None:  # noqa: ANN001
        pass


class _FakeProfileType:
    score_value = 0.9

    @staticmethod
    def load(path):  # noqa: ANN001
        return _FakeProfile(_FakeProfileType.score_value)


def _make_gate(
    monkeypatch: pytest.MonkeyPatch,
    *,
    detector: _FakeDetector | None = None,
    profile_score: float | None = None,
    timeout_s: float = 60.0,
) -> tuple[gate_module.SecurityGateHandler, _FakeDetector]:
    detector = detector or _FakeDetector()
    monkeypatch.setattr(gate_module, "WakeWordDetector", lambda **kwargs: detector)
    monkeypatch.setattr(gate_module, "Voiceprint", _FakeVoiceprint)
    if profile_score is not None:
        _FakeProfileType.score_value = profile_score
        monkeypatch.setattr(gate_module, "VoiceprintProfile", _FakeProfileType)

    gate = gate_module.SecurityGateHandler(
        threading.Event(),
        queue_in=None,  # type: ignore[arg-type]
        queue_out=None,  # type: ignore[arg-type]
        setup_kwargs={
            "voiceprint_enrollment": "profile.npz" if profile_score is not None else None,
            "voiceprint_threshold": 0.75,
            "security_timeout_s": timeout_s,
        },
    )
    return gate, detector


def test_gate_locked_swallows_audio(monkeypatch):
    gate, _detector = _make_gate(monkeypatch)
    assert list(gate.process(_chunk())) == []


def test_gate_unlocks_on_wake_word_and_forwards_after(monkeypatch):
    gate, _detector = _make_gate(monkeypatch, detector=_FakeDetector(detections=1))
    # The chunk that carries the wake word is swallowed too...
    assert list(gate.process(_chunk())) == []
    # ...everything after it flows downstream.
    chunk = _chunk()
    assert list(gate.process(chunk)) == [chunk]


def test_gate_voiceprint_rejected_stays_locked(monkeypatch):
    gate, _detector = _make_gate(
        monkeypatch, detector=_FakeDetector(fire_on_call=41), profile_score=0.1
    )
    for _ in range(41):  # ~1.3 s of audio, detection fires on the last chunk
        list(gate.process(_chunk()))
    assert list(gate.process(_chunk())) == []


def test_gate_voiceprint_accepted_unlocks(monkeypatch):
    gate, _detector = _make_gate(
        monkeypatch, detector=_FakeDetector(fire_on_call=41), profile_score=0.9
    )
    for _ in range(41):
        list(gate.process(_chunk()))
    chunk = _chunk()
    assert list(gate.process(chunk)) == [chunk]


def test_gate_idle_timeout_relocks(monkeypatch):
    gate, detector = _make_gate(monkeypatch, detector=_FakeDetector(detections=1), timeout_s=0.05)
    assert list(gate.process(_chunk())) == []  # wake word unlocks
    chunk = _chunk()
    assert list(gate.process(chunk)) == [chunk]  # audio flows
    time.sleep(0.1)  # quiet past the timeout
    assert list(gate.process(_chunk())) == []  # re-locked: audio swallowed again
    assert detector.reset_calls >= 1


def test_gate_loud_activity_keeps_unlocked(monkeypatch):
    """Audible activity must reset the idle timer (speech or assistant echo)."""
    gate, _detector = _make_gate(monkeypatch, detector=_FakeDetector(detections=1), timeout_s=0.05)
    list(gate.process(_chunk()))  # wake word unlocks
    end = time.monotonic() + 0.12
    while time.monotonic() < end:
        # Loud chunks (~0.3 peak) arrive continuously; the gate must stay open
        # well past the nominal timeout.
        loud = _chunk(value=0.3)
        assert list(gate.process(loud)) == [loud]
        time.sleep(0.01)


def test_gate_relocks_after_session_end(monkeypatch):
    gate, _detector = _make_gate(monkeypatch, detector=_FakeDetector(detections=1))
    assert list(gate.process(_chunk())) == []
    chunk = _chunk()
    assert list(gate.process(chunk)) == [chunk]
    gate.on_session_end()
    assert list(gate.process(_chunk())) == []


def test_voiceprint_profile_roundtrip_and_score(tmp_path: Path):
    profile = VoiceprintProfile(embedding=np.array([1.0, 0.0, 0.0], dtype=np.float32), takes=3)
    path = profile.save(tmp_path / "p.npz")
    loaded = VoiceprintProfile.load(path)
    assert loaded.score(np.array([1.0, 0.0, 0.0], dtype=np.float32)) == pytest.approx(1.0)
    assert loaded.score(np.array([0.0, 1.0, 0.0], dtype=np.float32)) == pytest.approx(0.0)
    assert loaded.takes == 3
    assert loaded.wake_word == "噜噜噜噜"


def test_voiceprint_profile_load_missing_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        VoiceprintProfile.load(tmp_path / "missing.npz")


def test_voiceprint_embed_rejects_short_audio():
    voiceprint = Voiceprint()
    with pytest.raises(ValueError):
        voiceprint.embed(np.zeros(100, dtype=np.float32))


def test_voiceprint_embed_with_cached_model():
    """Requires the funasr ERes2NetV2 model in the local ModelScope cache."""
    cached = Path.home() / ".cache" / "modelscope" / "models" / "iic--speech_eres2netv2_sv_zh-cn_16k-common"
    if not cached.exists():
        pytest.skip("ERes2NetV2 model not cached")
    voiceprint = Voiceprint()
    embedding = voiceprint.embed(np.zeros(16000, dtype=np.float32))
    assert embedding.shape == (192,)
