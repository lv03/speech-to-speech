from __future__ import annotations

import time
from queue import Queue
from threading import Event

import numpy as np
import torch

from speech_to_speech.pipeline.events import SpeechStartedEvent, SpeechStoppedEvent
from speech_to_speech.pipeline.speculative_turns import SpeculativeTurnTracker
from speech_to_speech.security.speaker_gate import GateDecision, GateStatus
from speech_to_speech.VAD.vad_handler import VADHandler


class _StaticIterator:
    def __init__(
        self,
        *,
        triggered: bool,
        vad_output: list[torch.Tensor] | None,
        buffer_chunks: list[torch.Tensor] | None = None,
        speech_chunks: list[torch.Tensor] | None = None,
        active_speech_samples: int = 0,
        last_utterance_active_speech_samples: int = 0,
    ) -> None:
        self.triggered = triggered
        self._vad_output = vad_output
        self.buffer = buffer_chunks or []
        self._speech_chunks = speech_chunks if speech_chunks is not None else self.buffer
        self.active_speech_samples = active_speech_samples
        self.last_utterance_active_speech_samples = last_utterance_active_speech_samples

    def __call__(self, _chunk: torch.Tensor) -> list[torch.Tensor] | None:
        return self._vad_output

    def speech_buffer(self) -> list[torch.Tensor]:
        return self._speech_chunks

    def reset_states(self) -> None:
        self.buffer = []
        self.triggered = False


class FakeTargetGate:
    def __init__(self, observed: list[GateStatus], final: GateStatus) -> None:
        self.observed = iter(observed)
        self.final_status = final
        self.started = 0
        self.reset_calls = 0
        self.closed = False

    def start_segment(self) -> None:
        self.started += 1

    def observe(self, _audio: np.ndarray, *, active_speech_ms: float) -> GateDecision:
        return GateDecision(next(self.observed), max_score=0.9 if active_speech_ms else None)

    def finish(self, _audio: np.ndarray) -> GateDecision:
        score = 0.9 if self.final_status is GateStatus.ACCEPTED else 0.1
        return GateDecision(self.final_status, max_score=score)

    def reset(self) -> None:
        self.reset_calls += 1

    def close(self) -> None:
        self.closed = True


class RecordingSmartTurnAnalyzer:
    def __init__(self) -> None:
        self.calls: list[np.ndarray] = []

    def predict(self, audio: np.ndarray, *, sample_rate: int):
        assert sample_rate == 16000
        self.calls.append(audio.copy())
        return _SmartTurnResult(True, 0.0, 0)


class _SmartTurnResult:
    def __init__(self, complete: bool, probability: float, inference_ms: int) -> None:
        self.complete = complete
        self.probability = probability
        self.inference_ms = inference_ms


def _make_handler(iterator: _StaticIterator, *, enable_realtime: bool = False) -> VADHandler:
    handler = object.__new__(VADHandler)
    handler.should_listen = Event()
    handler.should_listen.set()
    handler.sample_rate = 16000
    handler.min_silence_ms = 300
    handler.min_speech_ms = 384
    handler.min_speech_continuation_ms = 384
    handler.max_speech_ms = float("inf")
    handler.enable_realtime_transcription = enable_realtime
    handler.realtime_processing_pause = 0.5
    handler.text_output_queue: Queue = Queue()
    handler.speculative_turns = SpeculativeTurnTracker()
    handler.speculative_reopen_ms = 800
    handler.unanswered_reopen_ms = 7000
    handler._last_turn_detection = None
    handler.smart_turn_analyzer = None
    handler.smart_turn_max_wait_ms = 2000
    handler.smart_turn_incomplete_delay_ms = 600
    handler.iterator = iterator
    handler.audio_enhancement = False
    handler.last_process_time = 0.0
    handler._total_samples = 0
    handler._last_log_time = time.time()
    handler._log_chunks = 0
    handler._log_speech_starts = 0
    handler._log_speech_ends = 0
    handler._log_progressive_yields = 0
    handler._speech_started_emitted = False
    handler._turn_counter = 0
    handler._current_turn_id = None
    handler._current_turn_revision = None
    handler._speculative_audio_prefix = None
    handler._speculative_raw_audio_prefix = None
    handler._last_final_wall_time = None
    handler._last_final_audio_ms = None
    handler._pending_reopen_candidate = None
    handler.short_segment_merge_ms = 0
    handler._pending_short_segment = None
    handler.target_speaker_gate = None
    handler._speaker_gate_segment_active = False
    return handler


def active_handler(active_ms: float, chunk_values: list[float] | None = None) -> VADHandler:
    chunks = [torch.ones(512) * value for value in (chunk_values or [1.0])]
    iterator = _StaticIterator(
        triggered=True,
        vad_output=None,
        buffer_chunks=chunks,
        speech_chunks=chunks,
        active_speech_samples=int(active_ms / 1000 * 16000),
    )
    return _make_handler(iterator, enable_realtime=True)


def final_handler(active_ms: float) -> VADHandler:
    audio = torch.ones(int(active_ms / 1000 * 16000))
    iterator = _StaticIterator(
        triggered=False,
        vad_output=[audio],
        buffer_chunks=[],
        speech_chunks=[],
        last_utterance_active_speech_samples=int(active_ms / 1000 * 16000),
    )
    return _make_handler(iterator, enable_realtime=False)


def audio_bytes(samples: int = 512) -> bytes:
    return np.zeros(samples, dtype=np.int16).tobytes()


def test_pending_gate_emits_no_start_or_progressive():
    handler = active_handler(active_ms=900)
    handler.target_speaker_gate = FakeTargetGate([GateStatus.PENDING], GateStatus.REJECTED)

    assert list(handler.process(audio_bytes())) == []
    assert handler.text_output_queue.empty()
    assert handler._current_turn_id is None


def test_acceptance_emits_one_start_and_full_progressive_prefix():
    handler = active_handler(active_ms=900, chunk_values=[1.0, 2.0])
    handler.target_speaker_gate = FakeTargetGate([GateStatus.ACCEPTED], GateStatus.ACCEPTED)

    outputs = list(handler.process(audio_bytes()))

    started = handler.text_output_queue.get_nowait()
    assert isinstance(started, SpeechStartedEvent)
    assert len(outputs) == 1
    assert outputs[0].mode == "progressive"
    assert (outputs[0].audio == np.concatenate([np.ones(512), np.ones(512) * 2])).all()


def test_rejected_final_emits_nothing_and_skips_smart_turn():
    handler = final_handler(active_ms=900)
    analyzer = RecordingSmartTurnAnalyzer()
    handler.smart_turn_analyzer = analyzer
    handler.target_speaker_gate = FakeTargetGate([], GateStatus.REJECTED)

    outputs = list(handler.process(audio_bytes()))

    assert outputs == []
    assert handler.text_output_queue.empty()
    assert analyzer.calls == []
    assert handler._speculative_audio_prefix is None
    assert handler._pending_reopen_candidate is None
    assert handler._current_turn_id is None


def test_accepted_final_preserves_final_only_start_stop_pair():
    handler = final_handler(active_ms=900)
    handler.target_speaker_gate = FakeTargetGate([], GateStatus.ACCEPTED)

    outputs = list(handler.process(audio_bytes()))
    events = [handler.text_output_queue.get_nowait(), handler.text_output_queue.get_nowait()]

    assert isinstance(events[0], SpeechStartedEvent)
    assert events[0].interrupt_response is False
    assert isinstance(events[1], SpeechStoppedEvent)
    assert len(outputs) == 1
    assert outputs[0].mode == "final"


def test_on_session_end_resets_gate():
    handler = active_handler(active_ms=900)
    gate = FakeTargetGate([GateStatus.ACCEPTED], GateStatus.ACCEPTED)
    handler.target_speaker_gate = gate

    handler.on_session_end()

    assert gate.reset_calls == 1
    assert handler._speaker_gate_segment_active is False


def test_cleanup_closes_gate():
    handler = active_handler(active_ms=900)
    gate = FakeTargetGate([GateStatus.ACCEPTED], GateStatus.ACCEPTED)
    handler.target_speaker_gate = gate

    handler.cleanup()

    assert gate.closed is True
