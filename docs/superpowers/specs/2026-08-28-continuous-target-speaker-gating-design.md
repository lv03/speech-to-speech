# Continuous Target-Speaker Gating Design

Date: 2026-08-28
Status: Approved for implementation planning

## Objective

When voiceprint protection is enabled, the assistant must respond only to speech segments in which the enrolled user is detected.

The required product behavior is:

- A non-target speaker talking alone must not emit speech lifecycle events, interrupt assistant playback, reach STT or an audio-input LLM, or trigger a response.
- A segment is allowed once any verification window detects the enrolled user. This includes a segment containing overlapping target and non-target speech.
- The system does not edit or persist a target-only recording. When a mixed segment is allowed, STT may still recognize words spoken by the other speaker.
- Disabling voiceprint protection preserves the current VAD, live transcription, barge-in, and response behavior.

## Background

The current security gate verifies the speaker only on the wake-word audio. After the gate unlocks, it forwards every microphone chunk to the ordinary Silero VAD until the idle timeout or session end. As a result, every nearby speaker can be detected, transcribed, and answered during the unlocked interval.

A filter placed only between VAD and STT would be too late. `VADHandler` already emits `SpeechStartedEvent` before STT, and the Realtime service uses that event for barge-in and response cancellation. Target-speaker approval must therefore occur before both speech events and `VADAudio` leave the VAD stage.

The project already has the required first-stage speaker encoder: FunASR's ERes2NetV2 model produces 192-dimensional embeddings, and `VoiceprintProfile` scores them with cosine similarity. The external `FLamefiREz/speaker-verification` repository adds no required capability: it performs offline CMGAN enhancement followed by an older ERes2Net embedding and does not implement streaming PVAD or target-speaker extraction. It will not be added as a dependency.

Detailed source analysis and the longer-term PVAD/TSE assessment are recorded in [the research note](../../research/2026-08-28-target-speaker-gating.md).

## Scope

### P0: this implementation

P0 adds progressive sliding-window speaker verification around the existing ERes2NetV2 encoder. It is intended to make target-only and non-target-only turns behave correctly and to provide best-effort target detection in mixed speech.

### P1: explicitly deferred

P1 replaces the P0 gate decision with a trained personal/target-speaker VAD when internal overlap data shows that ordinary sliding-window verification is insufficient. Target-speaker extraction is deferred unless the product later requires removing the other person's words from an accepted mixed segment.

Anti-spoofing, microphone-array beamforming, cloud speaker services, speaker identification across multiple enrolled users, and high-risk command authorization are outside P0.

## Architecture

The logical pipeline becomes:

```text
Microphone PCM
  -> wake-word security gate
  -> Silero speech segmentation
  -> target-speaker decision inside the VAD emission boundary
  -> STT or audio-input LLM
  -> LLM
  -> TTS
```

The target-speaker decision is implemented with three bounded components.

### `VoiceprintVerifier`

`VoiceprintVerifier` owns the loaded ERes2NetV2 model and the enrolled profile. It exposes thread-safe `score(audio)` behavior and the existing clean wake-word adaptation operation. `PipelineGraph` creates one verifier per pipeline and injects the same instance into the wake-word gate and the conversation gate. A lock serializes model inference because the third-party model is not assumed to be reentrant.

This avoids loading two model copies and gives wake-word and conversation verification one profile and one scoring implementation.

### `TargetSpeakerGate`

`TargetSpeakerGate`, added under `security/`, is independent of Silero internals and STT queues. It owns only per-segment gate state, sliding-window scheduling, an executor with one worker, score summaries, and stale-result protection.

Its conceptual interface is:

```python
class TargetSpeakerGate:
    def start_segment(self, segment_id: int) -> None: ...
    def observe(self, audio: np.ndarray) -> GateDecision: ...
    def finish(self, audio: np.ndarray) -> GateDecision: ...
    def reset(self) -> None: ...
```

`GateDecision` reports `pending`, `accepted`, or `rejected` plus non-sensitive diagnostic metadata such as maximum score and decision latency. It never allocates turn IDs and never writes directly to event or STT queues.

### `VADHandler` integration

`VADHandler` remains the owner of speech segmentation, turn metadata, speculative reopen state, speech lifecycle events, and progressive/final audio. It receives an optional `TargetSpeakerGate`. When absent, existing code paths remain unchanged.

When present, `VADHandler` consults the gate before it:

- confirms a speculative reopen;
- allocates or increments turn metadata;
- emits `SpeechStartedEvent`;
- yields progressive `VADAudio`;
- emits `SpeechStoppedEvent`; or
- yields final `VADAudio`.

This boundary ensures that rejected speakers do not cancel an in-progress assistant response.

## Segment State Machine

Each Silero speech segment starts in `pending`:

```text
idle -> pending -> accepted -> idle
                \-> rejected -> idle
```

### Pending

While pending, VAD continues accumulating the ordinary segment buffer but emits no speech event or `VADAudio`. It also does not confirm a speculative reopen candidate. The assistant may continue playing.

Initial verification scheduling constants are:

- first check after approximately 800 ms of accumulated active speech;
- retry after each additional approximately 500 ms;
- verify the most recent approximately 1600 ms window;
- never call ERes2NetV2 with less than its existing 500 ms minimum.

These are initial engineering values, not model guarantees. They must remain named constants or internal configuration values so the evaluation harness can compare alternatives before they become stable public CLI options.

Only one verification may be in flight for a segment. If audio advances while a check runs, the gate remembers only the newest eligible position and schedules the newest window next. Historical windows do not accumulate in an executor queue.

### Accepted

Any score at or above `--voiceprint_threshold` permanently accepts the current segment. On the next VAD processing cycle, `VADHandler`:

1. allocates or confirms the turn using the original acoustic start time;
2. emits exactly one delayed `SpeechStartedEvent`;
3. exposes the complete accumulated segment, including audio buffered before approval, as the next progressive update; and
4. resumes the existing progressive and final processing behavior.

The segment is not re-verified after acceptance. This matches the approved rule that a mixed segment continues once the target user is detected anywhere in it.

Ordinary conversation windows never update the enrolled profile. Mixed audio could contaminate the template. Existing adaptive updates remain restricted to a clean, accepted wake-word sample.

### Rejected

A segment becomes rejected only when it ends without any accepted window, is shorter than the model minimum, or verification fails closed. Rejection produces no speech lifecycle events, no turn/revision changes, no progressive/final audio, and no smart-turn processing. Pending speculative reopen state is cancelled without modifying the previous turn's stored audio prefix.

At segment end, `finish()` uses the final eligible window if it has not already been scored. If an asynchronous check is still active, the VAD worker waits for that single result for at most 1 second before closing the segment. This prevents a completed pending segment from colliding with the next segment. Model exceptions or the 1-second timeout reject the segment and invalidate the late future. The timeout remains an internal named constant in P0 and is recorded by the latency metrics.

## Concurrency and Lifecycle

Each pipeline uses one target-speaker executor worker. VAD audio reception continues to queue while speaker inference runs. The expected model inference time is much shorter than the 500 ms retry hop, but queue depth and latency are measured rather than assumed.

Every segment has a monotonically increasing generation ID. Future results are applied only when both the pipeline/session generation and segment generation match. Session end, relock, handler reset, and new segment initialization invalidate older results.

The wake-word gate and conversation gate share a verifier lock. In normal operation they do not contend because conversation verification runs only after unlock, but serialization makes the lifecycle explicit and safe.

The expected target-user cost is approximately 0.8-1.1 seconds before the first speech event or live transcript. Once accepted, the existing live transcription cadence resumes. Non-target speech incurs local speaker inference but no STT or LLM cost.

## Enrollment and Profile Format

The existing enrollment protocol records repetitions of the wake word. That is not sufficient calibration for text-independent verification of arbitrary conversation.

The CLI enrollment flow will record multiple natural-speech takes of approximately 2-5 seconds each, totaling approximately 15-20 seconds. Prompts should elicit different content. Each accepted take is embedded and L2-normalized; the profile's authorization template is the L2-normalized, equal-weight mean of those take embeddings. P0 persists that centroid rather than multiple live authorization templates, keeping scoring and threshold calibration unambiguous. The profile also stores explicit metadata:

- schema version;
- model name and model version when available;
- enrollment protocol (`conversation_v1` versus legacy wake-word enrollment);
- number and duration of accepted takes;
- creation timestamp; and
- the wake word used by the security gate.

`VoiceprintProfile.load()` remains capable of reading the legacy single-embedding NPZ schema for `info`, deletion, and migration diagnostics. Continuous voiceprint startup with a legacy wake-word-only profile must fail with an actionable message asking the user to re-enroll; it must not silently promise conversation-level protection from an unsuitable template.

The CLI `verify` command will support natural-speech verification against the new profile and display score, threshold, and decision without saving the test audio.

## Configuration Semantics

`--enable_voiceprint` changes from "verify only the wake word" to "verify the wake word and every subsequent speech segment." It continues to require `--enable_wake_word` in P0.

The existing `--voiceprint_threshold` remains the only public acceptance threshold. A second public threshold is not introduced until internal measurements demonstrate a need for separate wake-word and conversation calibration. Help text and security documentation must stop claiming that same-speaker scores necessarily sit near 1.0 for arbitrary speech.

When voiceprint is disabled, the pipeline does not create a verifier or target gate. Wake-word-only mode remains available by enabling the wake word without enabling voiceprint.

## Error Handling and Observability

Speaker verification is fail-closed per segment. Import errors, missing or incompatible profiles, and model initialization failures fail pipeline startup with a clear error. Runtime inference errors or timeouts reject only the current segment and leave the session operational.

Logs contain no audio or transcription text. One structured summary per segment records:

- segment generation;
- accepted or rejected result;
- highest score and configured threshold;
- number of windows checked;
- decision latency;
- rejection reason; and
- whether the segment ended before the minimum duration.

Metrics should distinguish target-gate latency, model inference latency, stale results, skipped retry positions, rejected segments, accepted segments, and STT calls suppressed. Raw voice audio and new conversation embeddings are not persisted.

## Testing

### Deterministic behavior tests

Tests use a fake verifier and do not depend on real speaker scores:

- target-only speech accepted on the first window;
- early windows rejected and a later window accepted, with the complete sentence prefix released;
- non-target-only speech rejected with no start/stop event, STT input, LLM input, or assistant interruption;
- mixed speech represented by an accepted fake score and released as one complete segment;
- short speech accepted or rejected by the final eligible check;
- speech shorter than 500 ms rejected;
- inference exception and timeout fail closed;
- stale results after session reset or a new segment cannot accept current audio;
- no more than one verification task is in flight;
- rejected audio does not confirm speculative reopen, increment a turn revision, replace a speculative prefix, or run smart-turn analysis;
- accepted audio retains existing smart-turn, progressive transcription, and final transcription behavior;
- wake-word unlock, idle relock, and session-end relock remain correct; and
- disabling voiceprint preserves all existing VAD and Realtime tests.

### Acoustic evaluation

Before treating the feature as production-ready, a model-independent score harness evaluates the real ERes2NetV2 model over:

- target-only and non-target-only speakers;
- target plus non-target overlap, including target at the start, middle, and end;
- multiple non-target speakers overlapping without the target;
- television, phone playback, music, and ordinary non-speech noise;
- approximately 0.5, 1, 2, 3, and 5 second windows;
- near-field, 1 m, and 3 m recordings; and
- different rooms, directions, speaking styles, and sessions.

The threshold is selected under a defined non-target false-accept or Unauthorized Response Rate constraint. It is not selected at the equal-error point. Required reports include:

- non-target utterance false accept rate;
- target utterance false reject rate;
- target-present overlap recall;
- target-absent overlap false accept rate;
- unauthorized responses per 1000 non-target segments or exposure hour;
- non-target interruption count;
- acceptance latency P50/P95/P99;
- STT call suppression rate;
- overlap word intrusion rate; and
- inference latency, real-time factor, CPU/GPU use, and peak memory.

## P1 Upgrade Boundary

P0 is deliberately not described as frame-level personal VAD. A standard speaker encoder reduces a mixed window to one embedding and cannot reliably establish target presence under continuous overlap.

If internal evaluation shows inadequate target-present overlap recall or excessive target-absent overlap acceptance, `TargetSpeakerGate` becomes the stable seam for a P1 speaker-conditioned PVAD backend. The P1 backend should emit frame-level `non-speech`, `target speech`, and `non-target speech` probabilities and should replace or wrap Silero's speech decision before speech events are emitted.

If a future requirement says that an accepted mixed segment's transcript must exclude the other speaker, target-speaker extraction belongs before endpointing and STT. It is a separate capability and acceptance test, not a hidden extension of P0.

No P1 implementation may be selected without verifying checkpoint, training-data, and code licenses and measuring streaming behavior on the project's Apple Silicon and supported server platforms.

## Implementation Sequence

1. Add the offline score harness and gather initial target/non-target/overlap measurements across candidate window lengths.
2. Version the profile format and implement natural-speech multi-take enrollment.
3. Extract a shared thread-safe `VoiceprintVerifier` from the existing wake-word-only ownership.
4. Implement `TargetSpeakerGate` with deterministic fake-verifier tests.
5. Integrate the optional gate at the VAD event/audio emission boundary and add lifecycle, speculative-turn, and interruption tests.
6. Update CLI help and security documentation.
7. Run existing security, VAD, live transcription, Realtime, and end-to-end tests plus the real-model evaluation harness.
8. Calibrate the default/recommended threshold from held-out device recordings before enabling the feature in a production preset.

## Acceptance Criteria

The implementation is functionally complete when:

- deterministic tests prove that rejected speech cannot emit events, reach STT/LLM, or interrupt the assistant;
- accepted speech releases its complete buffered prefix and preserves current turn behavior;
- session and asynchronous lifecycle tests prove that stale decisions cannot authorize later audio;
- existing behavior is unchanged when voiceprint is disabled;
- the new enrollment protocol and legacy-profile error path are documented and tested; and
- an acoustic evaluation report provides the operating threshold and the measured target/non-target/overlap trade-offs for the intended microphone environment.
