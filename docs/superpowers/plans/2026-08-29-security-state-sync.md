# Security State Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop voice orb mirror the wake-word gate's initial locked state reliably, including startup and reconnect edges.

**Architecture:** Keep the fix small and local. The Python voice process will expose the gate's current state as soon as the desktop callback is attached, and the Electron main process will cache that state so the orb only hides after the voice engine is actually ready to reflect security changes. This preserves the existing event flow while removing the startup state gap.

**Tech Stack:** Python, TypeScript, Electron, pytest, tsconfig typecheck

> **Status (2026-09-08):** Partially implemented, plan file was never tracked. The Python side emits the gate's initial locked state as soon as the callback is attached; the regression test landed as `tests/openai_realtime/test_pipeline_builder.py::test_local_emits_initial_security_state_for_desktop_sync` in `e30bd59` ("fix: sync orb visibility with voice state"). The desktop side consumes the event path instead of the `emitCurrentSecurityState()` helper named in Step 3: `desktop/src/main/voice-process.ts` parses `security.locked`/`security.unlocked` and `desktop/src/main/index.ts` applies them through `setSecurityVisibility()`. The checkboxes below are still unchecked; re-verify the startup and reconnect edges before treating this plan as complete.

## Global Constraints

- Never include `codex` in branch names or pull request titles.
- Never commit local build artifacts such as `dist/`, `build/`, or generated wheel/sdist files.
- Keep the change focused on release-safe runtime behavior; do not touch unrelated UI or pipeline logic.

---

### Task 1: Lock-state regression coverage

**Files:**
- Modify: `tests/openai_realtime/test_pipeline_builder.py`
- Modify: `desktop/src/main/voice-process.ts`

**Interfaces:**
- Consumes: `EmbeddedVoice.onSecurityState`, `parseStdout()`
- Produces: initial `security.locked` or equivalent state delivery after the callback is attached

- [ ] **Step 1: Write the failing test**

```python
def test_local_pipeline_surfaces_initial_security_state(monkeypatch):
    args = _default_args()
    args.module_kwargs.enable_wake_word = True
    args.module_kwargs.local_audio_print_json = True
    unit = SimpleNamespace(handlers=[object()])
    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", lambda self, **_kwargs: unit)

    manager = build_local_pipeline(args, Event())

    # The local pipeline should emit the current locked state immediately after wiring the callback.
    # Capture stdout and assert an EVENT line for security.locked is present before any unlock.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/openai_realtime/test_pipeline_builder.py::test_local_pipeline_surfaces_initial_security_state -v`
Expected: FAIL because the initial security state is not emitted yet

- [ ] **Step 3: Write minimal implementation**

```ts
// In desktop/src/main/voice-process.ts
public emitCurrentSecurityState(): void {
  this.onSecurityState?.(this.currentSecurityLocked)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/openai_realtime/test_pipeline_builder.py::test_local_pipeline_surfaces_initial_security_state -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/openai_realtime/test_pipeline_builder.py desktop/src/main/voice-process.ts docs/superpowers/plans/2026-08-29-security-state-sync.md
git commit -m "fix: sync initial security state for desktop voice"
```

