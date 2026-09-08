# Continuous Target-Speaker Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `--enable_voiceprint` suppress every speech segment that does not contain the enrolled user before it can interrupt the assistant, reach STT, or trigger the LLM.

**Architecture:** Reuse one thread-safe ERes2NetV2 verifier for wake-word and conversation checks. A focused `TargetSpeakerGate` performs bounded asynchronous sliding-window verification, while `VADHandler` retains ownership of buffering, turn IDs, speech events, progressive/final audio, and speculative turns. The target decision occurs before VAD emits externally visible speech activity.

**Tech Stack:** Python 3.10+, NumPy, PyTorch/FunASR ERes2NetV2, `concurrent.futures.ThreadPoolExecutor`, pytest, existing Silero VAD and pipeline queues.

## Global Constraints

- Do not add `FLamefiREz/speaker-verification`, CMGAN, PVAD, TSE, or another model dependency in P0.
- Keep speaker-verification audio at 16 kHz mono float32.
- Keep one public `--voiceprint_threshold`; use internal defaults of 800 ms first check, 500 ms retry hop, 1600 ms window, 500 ms minimum audio, and 1 second final wait.
- Verification errors, timeouts, missing profiles, and incompatible profiles fail closed.
- Non-target speech emits no speech lifecycle events, confirms no speculative reopen, reaches neither STT nor LLM, and does not interrupt playback.
- Once any window passes, release the full buffered segment and do not re-verify that segment.
- Conversation audio never adapts the voiceprint; adaptation remains wake-word-only.
- Do not log raw audio, embeddings, or rejected transcripts.
- Preserve current behavior when voiceprint is disabled.
- Do not commit build artifacts or rewrite existing history.
- Production threshold calibration requires a user-owned target/non-target/overlap recording set; code completion delivers the harness and must not claim a production operating point without that data.
- Current unrelated static-analysis baseline: six Ruff findings in `LLM/language_model.py`, `announcer.py`, `cli.py`, and `s2s_pipeline.py`; two MyPy findings in `announcer.py` and `STT/paraformer_handler.py`. Touched files must introduce no additional findings.

## File Map

- Modify `security/voiceprint.py`: versioned profiles, normalized enrollment, shared verifier.
- Modify `security/gate.py`: use the shared verifier.
- Create `security/speaker_gate.py`: asynchronous per-segment state machine.
- Modify `VAD/vad_handler.py`: delay events and audio until acceptance.
- Modify `pipeline_graph.py`: construct and inject one verifier and target gate.
- Modify `cli.py` and `arguments_classes/module_arguments.py`: enrollment and CLI semantics.
- Create `security/evaluation.py` and `scripts/evaluate_voiceprint_gate.py`: offline calibration.
- Update security/user documentation and focused tests.

---

### Task 1: Version conversation voiceprint profiles

**Files:**
- Modify: `src/speech_to_speech/security/voiceprint.py:24-120`
- Modify: `tests/test_security.py:169-197`

**Interfaces:**
- Produces: `PROFILE_SCHEMA_VERSION`, `CONVERSATION_ENROLLMENT_PROTOCOL`, `LEGACY_ENROLLMENT_PROTOCOL`.
- Produces: `VoiceprintProfile.supports_conversation_gate` and `require_conversation_gate() -> None`.
- Changes: `Voiceprint.enroll(..., enrollment_protocol=CONVERSATION_ENROLLMENT_PROTOCOL)` creates a normalized centroid.

- [ ] **Step 1: Write failing schema and normalization tests**

Add to `tests/test_security.py`:

```python
from speech_to_speech.security.voiceprint import (
    CONVERSATION_ENROLLMENT_PROTOCOL,
    LEGACY_ENROLLMENT_PROTOCOL,
    PROFILE_SCHEMA_VERSION,
)


def test_profile_roundtrip_keeps_conversation_metadata(tmp_path: Path):
    profile = VoiceprintProfile(
        embedding=np.array([1.0, 0.0], dtype=np.float32),
        takes=4,
        total_duration_s=16.0,
        schema_version=PROFILE_SCHEMA_VERSION,
        enrollment_protocol=CONVERSATION_ENROLLMENT_PROTOCOL,
    )
    loaded = VoiceprintProfile.load(profile.save(tmp_path / "conversation.npz"))
    assert loaded.schema_version == PROFILE_SCHEMA_VERSION
    assert loaded.enrollment_protocol == CONVERSATION_ENROLLMENT_PROTOCOL
    assert loaded.total_duration_s == pytest.approx(16.0)
    assert loaded.supports_conversation_gate


def test_profile_loads_legacy_npz_for_diagnostics(tmp_path: Path):
    path = tmp_path / "legacy.npz"
    np.savez(
        path,
        embedding=np.array([1.0, 0.0], dtype=np.float32),
        model_name="legacy-model",
        wake_word="噜噜噜噜",
        takes=3,
        created_at=123.0,
    )
    loaded = VoiceprintProfile.load(path)
    assert loaded.schema_version == 1
    assert loaded.enrollment_protocol == LEGACY_ENROLLMENT_PROTOCOL
    with pytest.raises(ValueError, match="re-enroll"):
        loaded.require_conversation_gate()


def test_enroll_normalizes_each_take_before_centroid():
    voiceprint = Voiceprint()
    embeddings = iter(
        [np.array([10.0, 0.0], dtype=np.float32), np.array([0.0, 1.0], dtype=np.float32)]
    )
    voiceprint.embed = lambda _audio: next(embeddings)  # type: ignore[method-assign]
    profile = voiceprint.enroll(
        [np.ones(32000, dtype=np.float32), np.ones(48000, dtype=np.float32)],
        wake_word="噜噜噜噜",
    )
    expected = np.array([1.0, 1.0], dtype=np.float32) / np.sqrt(2.0)
    assert profile.embedding == pytest.approx(expected)
    assert profile.total_duration_s == pytest.approx(5.0)
```

- [ ] **Step 2: Verify the tests fail**

Run: `uv run pytest tests/test_security.py -k "conversation_metadata or legacy_npz or normalizes_each_take" -v`

Expected: FAIL because the new constants and fields are absent.

- [ ] **Step 3: Implement profile schema v2**

Add to `security/voiceprint.py`:

```python
PROFILE_SCHEMA_VERSION = 2
CONVERSATION_ENROLLMENT_PROTOCOL = "conversation_v1"
LEGACY_ENROLLMENT_PROTOCOL = "legacy_wake_word_v1"


def _normalized(embedding: np.ndarray) -> np.ndarray:
    value = np.asarray(embedding, dtype=np.float32).squeeze()
    norm = float(np.linalg.norm(value))
    if value.ndim != 1 or value.size == 0 or norm <= 0:
        raise ValueError("Voiceprint embedding must be a non-zero vector")
    return (value / norm).astype(np.float32)
```

Add these dataclass fields and methods:

```python
schema_version: int = PROFILE_SCHEMA_VERSION
enrollment_protocol: str = CONVERSATION_ENROLLMENT_PROTOCOL
total_duration_s: float = 0.0

@property
def supports_conversation_gate(self) -> bool:
    return (
        self.schema_version == PROFILE_SCHEMA_VERSION
        and self.enrollment_protocol == CONVERSATION_ENROLLMENT_PROTOCOL
    )

def require_conversation_gate(self) -> None:
    if not self.supports_conversation_gate:
        raise ValueError(
            "Voiceprint profile uses legacy wake-word enrollment; "
            "re-enroll with `speech-to-speech voiceprint enroll`."
        )
```

Persist the three fields in `save()`. In `load()`, derive legacy defaults using `data.files`. Replace enrollment averaging with:

```python
normalized_takes = np.stack([_normalized(self.embed(take)) for take in takes])
return VoiceprintProfile(
    embedding=_normalized(normalized_takes.mean(axis=0)),
    model_name=self.model_name,
    wake_word=wake_word,
    takes=len(takes),
    enrollment_protocol=enrollment_protocol,
    total_duration_s=sum(len(take) for take in takes) / SAMPLE_RATE,
)
```

Correct the `score()` docstring to cosine range `[-1, 1]`.

- [ ] **Step 4: Run profile/security tests**

Run: `uv run pytest tests/test_security.py -v`

Expected: PASS; the cached real-model test may SKIP when the model is absent.

- [ ] **Step 5: Commit**

```bash
git add src/speech_to_speech/security/voiceprint.py tests/test_security.py
git commit -m "feat: version voiceprint enrollment profiles"
```

---

### Task 2: Extract a shared thread-safe verifier

**Files:**
- Modify: `src/speech_to_speech/security/voiceprint.py`
- Modify: `src/speech_to_speech/security/gate.py:43-130`
- Modify: `tests/test_security.py:44-166`

**Interfaces:**
- Produces: `VoiceprintMatch(score: float, embedding: np.ndarray)`.
- Produces: `VoiceprintVerifier.load(path, require_conversation=False)`, `preload()`, `verify()`, `adapt()`.
- Changes: `SecurityGateHandler.setup(..., voiceprint_verifier: VoiceprintVerifier | None = None)`.

- [ ] **Step 1: Write failing verifier tests**

```python
def test_verifier_serializes_model_calls():
    active = 0
    peak = 0
    guard = threading.Lock()

    class SlowVoiceprint:
        @property
        def model(self):
            return object()

        def embed(self, _audio):
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
            time.sleep(0.02)
            with guard:
                active -= 1
            return np.array([1.0, 0.0], dtype=np.float32)

    verifier = VoiceprintVerifier(
        profile=VoiceprintProfile(embedding=np.array([1.0, 0.0], dtype=np.float32)),
        voiceprint=SlowVoiceprint(),  # type: ignore[arg-type]
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        matches = list(executor.map(verifier.verify, [np.ones(16000), np.ones(16000)]))
    assert [match.score for match in matches] == pytest.approx([1.0, 1.0])
    assert peak == 1
```

Also add `test_security_gate_uses_injected_verifier`, with a fake returning `VoiceprintMatch(0.9, np.ones(192))`, and assert the next chunk flows after wake detection.

- [ ] **Step 2: Verify red state**

Run: `uv run pytest tests/test_security.py -k "serializes_model_calls or injected_verifier" -v`

Expected: FAIL because the verifier types and setup argument do not exist.

- [ ] **Step 3: Implement the verifier**

Add to `security/voiceprint.py`:

```python
@dataclass(frozen=True)
class VoiceprintMatch:
    score: float
    embedding: np.ndarray


class VoiceprintVerifier:
    def __init__(self, *, profile, voiceprint, profile_path=None):
        self.profile = profile
        self.voiceprint = voiceprint
        self.profile_path = Path(profile_path) if profile_path else None
        self._lock = Lock()

    @classmethod
    def load(cls, path, *, require_conversation=False):
        profile = VoiceprintProfile.load(path)
        if require_conversation:
            profile.require_conversation_gate()
        return cls(
            profile=profile,
            voiceprint=Voiceprint(model_name=profile.model_name),
            profile_path=path,
        )

    def preload(self) -> None:
        with self._lock:
            _ = self.voiceprint.model

    def verify(self, audio: np.ndarray) -> VoiceprintMatch:
        with self._lock:
            embedding = self.voiceprint.embed(audio)
            return VoiceprintMatch(self.profile.score(embedding), embedding)

    def adapt(self, embedding: np.ndarray, *, weight: float = 0.15) -> None:
        with self._lock:
            self.profile.embedding = _normalized(
                (1.0 - weight) * self.profile.embedding + weight * embedding
            )
            if self.profile_path:
                self.profile.save(self.profile_path)
```

Refactor `SecurityGateHandler` to use `self._verifier.verify(wake_audio)` and `adapt(match.embedding)`. Keep `voiceprint_enrollment` only as a direct-construction compatibility path; reject supplying both it and `voiceprint_verifier`. Delete duplicate model/profile/adaptation fields.

- [ ] **Step 4: Run tests and commit**

```bash
uv run pytest tests/test_security.py -v
git add src/speech_to_speech/security/voiceprint.py src/speech_to_speech/security/gate.py tests/test_security.py
git commit -m "refactor: share the voiceprint verifier"
```

Expected: tests PASS, then the commit succeeds.

---

### Task 3: Implement the target-speaker state machine

**Files:**
- Create: `src/speech_to_speech/security/speaker_gate.py`
- Create: `tests/test_target_speaker_gate.py`

**Interfaces:**
- Consumes: `VoiceprintVerifier.verify() -> VoiceprintMatch`.
- Produces: `GateStatus`, `GateDecision`, and `TargetSpeakerGate` lifecycle methods.

- [ ] **Step 1: Write failing state-machine tests**

Create a fake verifier and tests for first-check delay, later-window acceptance, final rejection, sub-500-ms rejection, one in-flight task, permanent acceptance, exception, timeout, and reset invalidating a late result. Core test shape:

```python
class FakeVerifier:
    def __init__(self, scores):
        self.scores = iter(scores)
        self.windows = []

    def verify(self, audio):
        self.windows.append(audio.copy())
        return VoiceprintMatch(next(self.scores), np.ones(192, dtype=np.float32))


def wait_decision(gate, audio, active_ms):
    deadline = time.monotonic() + 1.0
    decision = gate.observe(audio, active_speech_ms=active_ms)
    while decision.status is GateStatus.PENDING and time.monotonic() < deadline:
        time.sleep(0.005)
        decision = gate.observe(audio, active_speech_ms=active_ms)
    return decision


def test_gate_retries_and_accepts_later_target():
    gate = TargetSpeakerGate(FakeVerifier([0.2, 0.9]), threshold=0.75)
    gate.start_segment()
    assert wait_decision(gate, np.ones(12800), 800).status is GateStatus.PENDING
    decision = wait_decision(gate, np.ones(20800), 1300)
    assert decision.status is GateStatus.ACCEPTED
    assert decision.checks == 2
    gate.close()


def test_gate_rejects_final_non_target():
    gate = TargetSpeakerGate(FakeVerifier([0.1]), threshold=0.75)
    gate.start_segment()
    decision = gate.finish(np.ones(16000, dtype=np.float32))
    assert decision.status is GateStatus.REJECTED
    assert decision.reason == "below_threshold"
    gate.close()
```

- [ ] **Step 2: Verify import failure**

Run: `uv run pytest tests/test_target_speaker_gate.py -v`

Expected: collection FAIL because `security.speaker_gate` is missing.

- [ ] **Step 3: Implement public types and constants**

```python
FIRST_CHECK_MS = 800
RETRY_HOP_MS = 500
WINDOW_MS = 1600
MIN_VERIFY_MS = 500
FINAL_WAIT_S = 1.0

class GateStatus(str, Enum):
    IDLE = "idle"
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"

@dataclass(frozen=True)
class GateDecision:
    status: GateStatus
    max_score: float | None = None
    checks: int = 0
    reason: str | None = None
    latency_s: float | None = None
```

`TargetSpeakerGate` stores the injected scorer as public read-only-by-convention `self.verifier` and owns one `ThreadPoolExecutor(max_workers=1)`, a monotonic segment generation, status, future, newest pending window, last submitted end sample, max score, check count, and start time. Use:

```python
def _window(self, audio: np.ndarray) -> np.ndarray:
    samples = int(self.window_ms * SAMPLE_RATE / 1000)
    return np.asarray(audio[-samples:], dtype=np.float32).copy()

def _run_check(self, generation, audio):
    return generation, self.verifier.verify(audio)
```

`observe()` collects a completed matching-generation future, accepts permanently at threshold, and schedules only after 800 ms or another 500 ms hop. While busy, retain only the newest eligible window. `finish()` waits at most 1 second, performs one unscored final eligible check, then returns accepted or a precise rejection reason. `reset()` increments generation and discards references; `close()` calls `shutdown(wait=False, cancel_futures=True)`. Emit one metadata-only summary log at acceptance/rejection.

- [ ] **Step 4: Run component checks and commit**

```bash
uv run pytest tests/test_target_speaker_gate.py -v
uv run ruff check src/speech_to_speech/security/speaker_gate.py tests/test_target_speaker_gate.py
uv run mypy src/speech_to_speech/security/speaker_gate.py
git add src/speech_to_speech/security/speaker_gate.py tests/test_target_speaker_gate.py
git commit -m "feat: add progressive target speaker gate"
```

Expected: tests, Ruff, and MyPy pass; commit succeeds.

---

### Task 4: Gate VAD events and audio before emission

**Files:**
- Modify: `src/speech_to_speech/VAD/vad_handler.py:52-160,543-840`
- Create: `tests/test_vad_speaker_gate.py`
- Modify: `tests/test_speculative_turns.py:362-401`

**Interfaces:**
- Consumes: `TargetSpeakerGate` and `GateStatus` from Task 3.
- Changes: `VADHandler.setup(..., target_speaker_gate: TargetSpeakerGate | None = None)`.
- Preserves: existing `SpeechStartedEvent`, `SpeechStoppedEvent`, and `VADAudio` contracts.

- [ ] **Step 1: Preserve the existing manual VAD fixture**

In `_vad_handler_for_iterator()` in `tests/test_speculative_turns.py`, add:

```python
handler.target_speaker_gate = None
handler._speaker_gate_segment_active = False
```

- [ ] **Step 2: Write failing VAD boundary tests**

Create `tests/test_vad_speaker_gate.py` with a local static iterator fixture and:

```python
class FakeTargetGate:
    def __init__(self, observed, final):
        self.observed = iter(observed)
        self.final_status = final
        self.started = 0
        self.reset_calls = 0
        self.closed = False

    def start_segment(self):
        self.started += 1

    def observe(self, _audio, *, active_speech_ms):
        return GateDecision(next(self.observed), max_score=0.9 if active_speech_ms else None)

    def finish(self, _audio):
        score = 0.9 if self.final_status is GateStatus.ACCEPTED else 0.1
        return GateDecision(self.final_status, max_score=score)

    def reset(self):
        self.reset_calls += 1

    def close(self):
        self.closed = True
```

Test the four primary behaviors:

```python
def test_pending_gate_emits_no_start_or_progressive():
    handler = active_handler(active_ms=900)
    handler.enable_realtime_transcription = True
    handler.target_speaker_gate = FakeTargetGate([GateStatus.PENDING], GateStatus.REJECTED)
    assert list(handler.process(audio_bytes())) == []
    assert handler.text_output_queue.empty()
    assert handler._current_turn_id is None


def test_acceptance_emits_one_start_and_full_progressive_prefix():
    handler = active_handler(active_ms=900, chunk_values=[1.0, 2.0])
    handler.enable_realtime_transcription = True
    handler.target_speaker_gate = FakeTargetGate([GateStatus.ACCEPTED], GateStatus.ACCEPTED)
    outputs = list(handler.process(audio_bytes()))
    assert isinstance(handler.text_output_queue.get_nowait(), SpeechStartedEvent)
    assert len(outputs) == 1 and outputs[0].mode == "progressive"
    assert outputs[0].audio == pytest.approx(
        np.concatenate([np.ones(512), np.ones(512) * 2])
    )


def test_rejected_final_emits_nothing_and_skips_smart_turn():
    handler = final_handler(active_ms=900)
    analyzer = RecordingSmartTurnAnalyzer()
    handler.smart_turn_analyzer = analyzer
    handler.target_speaker_gate = FakeTargetGate([], GateStatus.REJECTED)
    assert list(handler.process(audio_bytes())) == []
    assert handler.text_output_queue.empty()
    assert analyzer.calls == []
    assert handler._speculative_audio_prefix is None


def test_accepted_final_preserves_final_only_start_stop_pair():
    handler = final_handler(active_ms=900)
    handler.target_speaker_gate = FakeTargetGate([], GateStatus.ACCEPTED)
    outputs = list(handler.process(audio_bytes()))
    events = [handler.text_output_queue.get_nowait(), handler.text_output_queue.get_nowait()]
    assert isinstance(events[0], SpeechStartedEvent)
    assert events[0].interrupt_response is False
    assert isinstance(events[1], SpeechStoppedEvent)
    assert len(outputs) == 1 and outputs[0].mode == "final"
```

Also test: rejected continuation does not increment a revision; `on_session_end()` resets; `cleanup()` closes; phantom/invalid segments reset gate state.

- [ ] **Step 3: Verify the tests fail**

Run: `uv run pytest tests/test_vad_speaker_gate.py -v`

Expected: FAIL because VAD does not consult the target gate.

- [ ] **Step 4: Add focused VAD gate helpers**

Store the optional gate and active flag in `setup()`. Add:

```python
def _speaker_gate_start_if_needed(self) -> None:
    if self.target_speaker_gate is not None and not self._speaker_gate_segment_active:
        self.target_speaker_gate.start_segment()
        self._speaker_gate_segment_active = True

def _speaker_gate_observe(self) -> GateStatus:
    if self.target_speaker_gate is None:
        return GateStatus.ACCEPTED
    self._speaker_gate_start_if_needed()
    audio = torch.cat(self.iterator.speech_buffer()).cpu().numpy()
    return self.target_speaker_gate.observe(
        audio,
        active_speech_ms=self._current_active_speech_duration_ms(),
    ).status

def _speaker_gate_finish(self, audio: np.ndarray) -> GateStatus:
    if self.target_speaker_gate is None:
        return GateStatus.ACCEPTED
    self._speaker_gate_start_if_needed()
    status = self.target_speaker_gate.finish(audio).status
    self._speaker_gate_segment_active = False
    return status

def _speaker_gate_reset_segment(self) -> None:
    if self.target_speaker_gate is not None and self._speaker_gate_segment_active:
        self.target_speaker_gate.reset()
    self._speaker_gate_segment_active = False
```

- [ ] **Step 5: Guard every event/audio exit**

For active Silero speech, call `_speaker_gate_observe()` before `_begin_pending_reopen_if_needed()`. Only accepted status may allocate a turn, emit start, or yield progressive audio.

After final short-segment stitching and before turn allocation/smart-turn analysis, call `_speaker_gate_finish(array)`. On rejection execute:

```python
logger.info("VAD: target speaker gate rejected segment; suppressing events and audio")
self._cancel_pending_reopen()
self._speech_started_emitted = False
self.last_process_time = 0.0
return
```

Reset gate state on phantom/invalid segments. Call `target_speaker_gate.reset()` from `on_session_end()`. Add:

```python
def cleanup(self) -> None:
    if self.target_speaker_gate is not None:
        self.target_speaker_gate.close()
```

- [ ] **Step 6: Run VAD regressions and commit**

```bash
uv run pytest tests/test_vad_speaker_gate.py tests/test_speculative_turns.py tests/test_smart_turn.py -v
uv run ruff check src/speech_to_speech/VAD/vad_handler.py tests/test_vad_speaker_gate.py tests/test_speculative_turns.py
git add src/speech_to_speech/VAD/vad_handler.py tests/test_vad_speaker_gate.py tests/test_speculative_turns.py
git commit -m "feat: gate VAD events by target speaker"
```

Expected: all tests and Ruff pass; commit succeeds.

---

### Task 5: Wire one verifier through each pipeline

**Files:**
- Modify: `src/speech_to_speech/pipeline_graph.py:164-200`
- Modify: `src/speech_to_speech/arguments_classes/module_arguments.py:114-151`
- Modify: `tests/test_backend_registry.py`
- Modify: `tests/test_cli_defaults.py`

**Interfaces:**
- Consumes: `VoiceprintVerifier.load(..., require_conversation=True)` and `TargetSpeakerGate`.
- Produces: one verifier shared by wake gate and VAD gate per pipeline.

- [ ] **Step 1: Write a failing wiring test**

In `tests/test_backend_registry.py`, monkeypatch handlers and verifier construction, then assert:

```python
assert loaded_profiles == [(str(profile_path), True)]
assert captured.security_gate_kwargs["voiceprint_verifier"] is shared_verifier
assert captured.vad_kwargs["target_speaker_gate"].verifier is shared_verifier
```

The test helper must replace concrete STT/LLM/TTS handlers so it never loads models.

- [ ] **Step 2: Verify red state**

Run: `uv run pytest tests/test_backend_registry.py -k "shares_voiceprint_verifier" -v`

Expected: FAIL because pipeline composition passes only the profile path to the wake gate.

- [ ] **Step 3: Construct the shared objects**

In `_build_pipeline()`:

```python
voiceprint_verifier = None
target_speaker_gate = None
enrollment = module_kwargs.voiceprint_enrollment
if module_kwargs.enable_voiceprint:
    from speech_to_speech.security.speaker_gate import TargetSpeakerGate
    from speech_to_speech.security.voiceprint import VoiceprintVerifier

    enrollment = enrollment or str(
        Path.home() / ".cache" / "speech_to_speech" / "voiceprint" / "default.npz"
    )
    voiceprint_verifier = VoiceprintVerifier.load(enrollment, require_conversation=True)
    voiceprint_verifier.preload()
    target_speaker_gate = TargetSpeakerGate(
        voiceprint_verifier,
        threshold=module_kwargs.voiceprint_threshold,
    )
```

Pass `voiceprint_verifier` to `SecurityGateHandler` and `target_speaker_gate` to `VADHandler`. Do not pass a profile path alongside an injected verifier.

- [ ] **Step 4: Correct public help and protect defaults**

Replace `enable_voiceprint` help with:

```python
"Verify the enrolled speaker on the wake word and every subsequent speech segment before "
"emitting speech events or sending audio to STT. Requires --enable_wake_word and a "
"conversation profile created with `speech-to-speech voiceprint enroll`. Off by default."
```

Remove the claim that arbitrary same-speaker speech scores near 1.0. Add:

```python
def test_voiceprint_defaults_remain_opt_in():
    args = ModuleArguments()
    assert args.enable_wake_word is False
    assert args.enable_voiceprint is False
    assert args.voiceprint_threshold == pytest.approx(0.75)
```

- [ ] **Step 5: Run tests and commit**

```bash
uv run pytest tests/test_backend_registry.py tests/test_cli_defaults.py tests/test_security.py -v
git add src/speech_to_speech/pipeline_graph.py src/speech_to_speech/arguments_classes/module_arguments.py tests/test_backend_registry.py tests/test_cli_defaults.py
git commit -m "feat: wire continuous voiceprint protection"
```

Expected: PASS without real model loading; commit succeeds.

---

### Task 6: Migrate CLI enrollment to natural speech

**Files:**
- Modify: `src/speech_to_speech/cli.py:196-277`
- Create: `tests/test_voiceprint_cli.py`

**Interfaces:**
- Consumes: conversation profile schema from Task 1.
- Produces: five 4-second natural-speech takes by default; `--take-duration` supports 2-10 seconds.
- Preserves: `--wake-word` as profile metadata, not required enrollment content.

- [ ] **Step 1: Write failing CLI tests**

```python
def test_enroll_records_natural_speech_profile(monkeypatch, tmp_path, capsys):
    recorded = []

    def fake_record(duration_s=4.0):
        recorded.append(duration_s)
        return np.ones(int(duration_s * 16000), dtype=np.float32)

    class FakeVoiceprint:
        def enroll(self, takes, *, wake_word, enrollment_protocol):
            assert len(takes) == 2
            assert enrollment_protocol == "conversation_v1"
            return cli_module.VoiceprintProfile(
                embedding=np.array([1.0, 0.0], dtype=np.float32),
                wake_word=wake_word,
                takes=2,
                total_duration_s=8.0,
            )

    monkeypatch.setattr(cli_module, "_record_voiceprint_take", fake_record)
    monkeypatch.setattr(cli_module, "Voiceprint", FakeVoiceprint)
    output = tmp_path / "profile.npz"
    cli_module.run_voiceprint_command(
        ["enroll", "--takes", "2", "--take-duration", "4", "--output", str(output)]
    )
    assert recorded == [4.0, 4.0]
    assert output.is_file()
    assert "自然说话" in capsys.readouterr().out


def test_info_marks_legacy_profile(tmp_path, capsys):
    path = tmp_path / "legacy.npz"
    np.savez(
        path,
        embedding=np.array([1.0, 0.0], dtype=np.float32),
        model_name="legacy-model",
        wake_word="噜噜噜噜",
        takes=3,
        created_at=123.0,
    )
    cli_module.run_voiceprint_command(["info", "--profile", str(path)])
    assert "legacy_wake_word_v1" in capsys.readouterr().out
```

- [ ] **Step 2: Verify red state**

Run: `uv run pytest tests/test_voiceprint_cli.py -v`

Expected: FAIL because the new option and protocol messaging are absent.

- [ ] **Step 3: Implement deterministic natural-speech prompts**

```python
_VOICEPRINT_ENROLLMENT_PROMPTS = (
    "今天天气不错，我正在测试自己的声音。",
    "请只让系统响应我说出的语音指令。",
    "这段录音用于建立本地声纹识别档案。",
    "我会用正常的速度和音量继续说话。",
    "现在完成最后一段自然语音注册录音。",
)
```

Set `--takes` default 5, add `--take-duration` default 4.0, and enforce `2.0 <= duration <= 10.0`. Record natural-speech takes without `crop_last_speech_burst()`. Call:

```python
profile = extractor.enroll(
    takes,
    wake_word=namespace.wake_word,
    enrollment_protocol=CONVERSATION_ENROLLMENT_PROTOCOL,
)
```

`verify` records 4 seconds of natural speech. `info` prints schema, protocol, total duration, and continuous-gate compatibility.

- [ ] **Step 4: Run tests and commit**

```bash
uv run pytest tests/test_voiceprint_cli.py tests/test_security.py -v
git add src/speech_to_speech/cli.py tests/test_voiceprint_cli.py
git commit -m "feat: enroll voiceprints from natural speech"
```

Expected: PASS and commit succeeds.

---

### Task 7: Add an acoustic evaluation harness

**Files:**
- Create: `src/speech_to_speech/security/evaluation.py`
- Create: `scripts/evaluate_voiceprint_gate.py`
- Create: `tests/test_voiceprint_evaluation.py`

**Interfaces:**
- Produces: `EvaluationTrial`, `EvaluationSummary`, and `evaluate_trials()`.
- Manifest JSONL fields: `audio_filepath`, `label`, `target_present`; label is `target`, `non_target`, or `overlap`.

- [ ] **Step 1: Write failing metric tests**

```python
def test_evaluate_trials_reports_product_metrics():
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
```

Add tests proving each required slice raises `ValueError` when absent.

- [ ] **Step 2: Verify import failure**

Run: `uv run pytest tests/test_voiceprint_evaluation.py -v`

Expected: collection FAIL because `security.evaluation` is absent.

- [ ] **Step 3: Implement model-independent aggregation**

```python
@dataclass(frozen=True)
class EvaluationTrial:
    label: Literal["target", "non_target", "overlap"]
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
```

`evaluate_trials()` selects each exact slice, rejects empty slices, and uses `np.percentile` over accepted-trial latency. It returns rates as counts divided by slice size.

- [ ] **Step 4: Implement the JSONL real-model CLI**

The script accepts:

```text
--profile PATH
--manifest PATH
--threshold FLOAT (repeatable)
--window-ms 800,1200,1600,2000
--hop-ms 500
--output PATH
```

Use `soundfile.read(always_2d=False)`, reject multi-channel input, resample to 16 kHz with `scipy.signal.resample_poly`, and call `VoiceprintVerifier` over growing latest windows. Write JSON containing profile/model/protocol, configuration, per-trial maximum scores/latencies, and aggregate metrics—never audio or embeddings. End with:

```python
if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run checks and commit**

```bash
uv run pytest tests/test_voiceprint_evaluation.py -v
uv run python scripts/evaluate_voiceprint_gate.py --help
uv run ruff check src/speech_to_speech/security/evaluation.py scripts/evaluate_voiceprint_gate.py tests/test_voiceprint_evaluation.py
git add src/speech_to_speech/security/evaluation.py scripts/evaluate_voiceprint_gate.py tests/test_voiceprint_evaluation.py
git commit -m "feat: add voiceprint gate evaluation harness"
```

Expected: tests and Ruff pass, help lists every option, commit succeeds.

---

### Task 8: Document behavior, migration, and limitations

**Files:**
- Modify: `src/speech_to_speech/security/README.md`
- Modify: `README.md:215,299-317,683`

**Interfaces:**
- Consumes: final runtime and CLI behavior from Tasks 1-7.
- Produces: operator guidance that does not overstate mixed-speech or anti-spoof capability.

- [ ] **Step 1: Replace the architecture and enrollment sections**

Document:

```text
locked: PCM -> wake word -> shared ERes2NetV2 verifier -> unlock
unlocked: PCM -> Silero buffer -> sliding ERes2NetV2 target gate
          accepted -> speech events + STT/LLM
          rejected -> silent discard
```

Replace three wake-word repetitions with five 4-second natural-speech takes. State that legacy profiles are inspectable but must be re-enrolled before continuous gating.

- [ ] **Step 2: Document exact runtime semantics**

State all of the following:

- `--enable_voiceprint` verifies wake word and every subsequent segment.
- First event/transcript is delayed roughly 0.8-1.1 seconds before device calibration.
- Any accepted window releases the complete segment.
- Rejected speech causes no barge-in, transcription, or response.
- Mixed speech may still add the other person's words to STT.
- Conversation audio never adapts the profile.
- Thresholds come from held-out target/non-target/overlap recordings, not EER alone.
- Voiceprint does not prevent replay/deepfake attacks or authorize high-risk actions by itself.

- [ ] **Step 3: Add evaluation usage**

```bash
uv run python scripts/evaluate_voiceprint_gate.py \
  --profile ~/.cache/speech_to_speech/voiceprint/default.npz \
  --manifest ./voiceprint-eval/manifest.jsonl \
  --threshold 0.60 --threshold 0.65 --threshold 0.70 \
  --window-ms 800,1200,1600,2000 \
  --hop-ms 500 \
  --output ./voiceprint-eval/report.json
```

Include a valid row:

```json
{"audio_filepath":"audio/non_target_001.wav","label":"non_target","target_present":false}
```

- [ ] **Step 4: Check stale wording and commit**

```bash
rg -n "唤醒词.*3 遍|scores near 1|只.*唤醒词" README.md src/speech_to_speech/security/README.md
git diff --check
git add README.md src/speech_to_speech/security/README.md
git commit -m "docs: explain continuous voiceprint gating"
```

Expected: search finds no stale behavior claim, diff check passes, commit succeeds.

---

### Task 9: Run the complete verification matrix

**Files:**
- Verify only. Fix a failure in the owning earlier task rather than adding a catch-all patch.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: evidence that gated and ungated paths pass together.

- [x] **Step 1: Run focused target-speaker tests**

```bash
uv run pytest \
  tests/test_security.py \
  tests/test_target_speaker_gate.py \
  tests/test_vad_speaker_gate.py \
  tests/test_voiceprint_cli.py \
  tests/test_voiceprint_evaluation.py \
  -v
```

Expected: PASS; only the existing cached-model test may SKIP when its model is absent.

- [x] **Step 2: Run adjacent regressions**

```bash
uv run pytest \
  tests/test_vad_iterator.py \
  tests/test_speculative_turns.py \
  tests/test_smart_turn.py \
  tests/test_transcription_notifier.py \
  tests/test_whisper_progressive_transcription.py \
  tests/test_audio_streaming.py \
  tests/openai_realtime \
  -v
```

Expected: PASS with unchanged voiceprint-disabled behavior.

- [x] **Step 3: Run the full test suite**

```bash
uv run pytest -q
```

Expected: tests PASS; environment-dependent tests only use their existing documented skips.

- [x] **Step 4: Run focused and repository-wide static checks**

Run focused checks that must exit 0:

```bash
uv run ruff check \
  src/speech_to_speech/security/voiceprint.py \
  src/speech_to_speech/security/gate.py \
  src/speech_to_speech/security/speaker_gate.py \
  src/speech_to_speech/security/evaluation.py \
  src/speech_to_speech/VAD/vad_handler.py \
  src/speech_to_speech/pipeline_graph.py \
  src/speech_to_speech/arguments_classes/module_arguments.py \
  scripts/evaluate_voiceprint_gate.py \
  tests/test_security.py \
  tests/test_target_speaker_gate.py \
  tests/test_vad_speaker_gate.py \
  tests/test_voiceprint_cli.py \
  tests/test_voiceprint_evaluation.py
uv run mypy \
  src/speech_to_speech/security/voiceprint.py \
  src/speech_to_speech/security/gate.py \
  src/speech_to_speech/security/speaker_gate.py \
  src/speech_to_speech/security/evaluation.py
git diff --check
```

Then run baseline visibility checks:

```bash
uv run ruff check src tests scripts
uv run mypy src/speech_to_speech
```

Expected: focused checks and `git diff --check` exit 0. Repository-wide output may retain only the six Ruff and two MyPy findings recorded under Global Constraints; it must contain no finding in a file changed by this plan beyond the pre-existing `cli.py` import-order finding, which the CLI task should remove while touching that import block.

- [x] **Step 5: Run a local profile smoke test when hardware is available**

```bash
uv run speech-to-speech voiceprint info
uv run speech-to-speech voiceprint verify --threshold 0.75
```

Expected: profile reports `conversation_v1`; verify prints score and verdict without persisting its recording. Re-enroll first when `info` reports a legacy protocol.

- [x] **Step 6: Review commits and cleanliness**

```bash
git log --oneline --decorate -10
git status --short
```

Expected: focused commits for schema, verifier, target gate, VAD, wiring, enrollment, evaluation, and docs; working tree clean.

---

### Task 9 evidence (2026-09-08, macOS 15.1 arm64, `.venv` CPython 3.11.13)

Commands were run with `PYTHONPATH=.:src ./.venv/bin/python -m pytest` / `python -m ruff` / `python -m mypy` because `uv run` is not part of this workstation's workflow; results are equivalent.

| Step | Result |
|---|---|
| 1 focused target-speaker tests | PASS — `38 passed in 8.19s` (`test_security`, `test_target_speaker_gate`, `test_vad_speaker_gate`, `test_voiceprint_cli`, `test_voiceprint_evaluation`) |
| 2 adjacent regressions | PASS — `527 passed, 1 skipped in 89.14s` (the skip is the newly documented environment skip below) |
| 3 full suite | PASS — `1511 passed, 2 skipped, 4 warnings in 99.70s` |
| 4 focused static checks | PASS — focused `ruff check` "All checks passed"; focused `mypy` "no issues found in 4 source files"; `git diff --check` exit 0 |
| 4 repository-wide static checks | Deviation from the recorded baseline: `ruff check src tests scripts` reports 5 findings and `mypy src/speech_to_speech` reports 13 errors in 4 files. None is introduced by this plan: the Ruff findings are in `LLM/language_model.py`, `tests/openai_realtime/test_session_state.py`, `tests/test_local_speaker.py`; the MyPy errors are in `s2s_pipeline.py` (8), `utils/mlx_lock.py` (2), `STT/paraformer_handler.py` (1, pre-existing) and `VAD/vad_handler.py` (2, introduced by `fe44d14` "VAD 懒加载", not by Task 4). Tracked as an unrelated baseline refresh, not a gating regression. |
| 5 profile smoke | `voiceprint info` reports `档案版本 2` / `注册协议 conversation_v1` / `支持持续声纹门控: 是`. `voiceprint verify --threshold 0.75` completed, printed `相似度: 0.0432（阈值 0.75）→ 拒绝`, and persisted no recording. Peak input was 0.01 (no real speaker at the workstation), so this is a smoke result, not a threshold calibration. |
| 6 commits and cleanliness | Focused commits exist for schema (`0801746`), verifier (`13e9ff7`), target gate (`c8a379d`), VAD (`07116c8`), wiring (`fe44d14`), enrollment (`dee1941`), evaluation (`9b031e5`) and docs (`61b1831`). Working tree is clean after the 2026-09-08 hygiene commits. |

**Environment-dependent test handling (the two failures seen on 2026-09-08 before closeout).** Both reproduced identically on `main`, so neither was caused by this plan:

1. `tests/openai_realtime/test_llm_proxy.py::TestStreamingPassthrough::test_unreachable_upstream_fails_cleanly_within_connect_timeout` — the sandbox answers the blackhole address `10.255.255.1:9` with a synthetic `502` (empty body) after ~5 s instead of failing the connect, so the proxy forwards that response verbatim and never synthesizes its own error envelope. The test now probes egress once (`_blackhole_egress_is_intercepted()`) and skips with that reason; on a normal network the probe returns False and the original assertions run unchanged.
2. `tests/openai_realtime/test_webrtc.py::TestWebRTCLoopback::test_close_awaits_pending_ice_checks` — real ICE connectivity never completes in the sandbox (UDP checks get no reply), so no observable `aioice` check task existed within the 1 s deadline. The test now parks one candidate pair in `IN_PROGRESS` with a controllable pending task when no real check appears (`_park_pending_ice_check()`), which is the same state the close sweep has to cancel and await. The test passes deterministically instead of being skipped, so the close-await behavior stays covered.
