# Decision record: the optional memory backend

Status 2026-09-08. These are the decisions the implementation encodes, so final
acceptance can review them as statements rather than reverse-engineer them from
code.

## D1 — Memory is off by default, and enabling it takes four explicit inputs

The voice engine behaves exactly as before unless **all** of these are set:

| Input | Where | Effect when missing |
|---|---|---|
| `memoryEnabled` | settings toggle | provider is never constructed |
| `memoryCloudConsent` | settings toggle | provider is never constructed |
| `memorySidecarPython` + `memorySidecarScript` | settings paths | `MemoryConfigError`; the voice engine keeps running without memory and reports a degraded `memory.health` event |
| `memoryExtractionBaseUrl` | settings | same as above |

`index.ts` always supplies the app-private `<userData>/memory` root; the paths
travel to the child **through the environment**, never argv.

Rationale: memory is the one feature that sends user utterances to a model and
stores derived facts. It must never be reachable by accident.

## D2 — Cloud extraction is supported, but the endpoint is never assumed

voicemem has no local fact-extraction path: writes call an OpenAI-compatible
chat endpoint. Two supported configurations:

1. **Local**: point `memoryExtractionBaseUrl` at a loopback server
   (`http://127.0.0.1:8080/v1` for vLLM/Ollama/llama.cpp). Utterance text never
   leaves the machine; voicemem example 04 proves the shape.
2. **Remote**: point it at a hosted provider (e.g. `https://api.deepseek.com`).
   This requires the consent toggle, whose UI text states plainly that utterance
   text is sent to the configured endpoint.

The endpoint is **required** rather than defaulted: voicemem would otherwise fall
back to `api.openai.com`, which is neither the user's choice nor necessarily
reachable. The endpoint and model are scoped to the sidecar child process only
(`OPENAI_BASE_URL`/`OPENAI_MODEL` in its environment) so they cannot redirect
other components such as the STT/TTS backends.

Reads never leave the machine: retrieval embeds locally through the QMD daemon's
patched `/embed` route (`EMBEDDER.md`; no E5 model is loaded) and searches a
local vector store inside the sidecar — mem0's embedded Qdrant today, with
`STORE_SWAP.md` proposing SQLite/sqlite-vec as the replacement.

## D3 — Injection is silent, and that is deliberate

The memory block is injected as its own system message for the current response
only. It is not printed into the transcript and not announced by the assistant.
What the user can see: the settings page's backend status line (connected /
degraded / off, lock state, pending writes).

Rationale: voicemem's own guidance and the qwen-audio-agent integration both
treat the block as internal context — the model is instructed not to quote it.
Making it visible in the conversation would also change the conversational
transcript we test against.

## D4 — No `recall_memory` tool in this iteration

The provider exposes `recall`, but nothing binds it as a Realtime tool. Automatic
per-response injection is the whole point of the feature; adding a tool as well
would double the LLM-visible surface and the review burden. It stays available
for a future audit-oriented iteration.

## D5 — Fail-closed on every path

| Failure | Behaviour |
|---|---|
| Session locked (voiceprint/wake-word gate) | no read, no write; provider mirrors the gate |
| Sidecar not installed / not answering | provider logs a warning, returns empty context, never raises into the voice loop |
| Sidecar crashes mid-session | respawned **locked**; reads fail closed until the gate re-unlocks |
| Bad memory configuration | voice engine starts normally, emits `memory.health` with `ok: false` and the reason |
| Write fails | batch is requeued and not marked seen; the next flush retries |
| Sensitive utterance (keys, passwords, ID numbers, medical terms) | dropped before it reaches the store |
| Duplicate or stale turn | ignored by `(session, turn, revision)` dedup, persisted across restarts |
| Prefetch result from an older revision | discarded as stale |

## Acceptance checklist

Run from the repository root; the memory sidecar needs its own venv
(`~/.cache/speech-to-speech/voicemem-venv` here).

- [ ] `PYTHONPATH=.:src ./.venv/bin/python -m pytest -q` → all pass (currently 1596 passed, 2 skipped)
- [ ] `cd desktop && npm test` → all pass (currently 142, 20 files); `npx tsc --noEmit -p tsconfig.json` clean
- [ ] `./.venv/bin/python -m ruff check src tests experiments/voicemem` → no new findings (5 pre-existing)
- [ ] Memory stays off with default settings: `speech-to-speech local` produces no `memory.health` event and no sidecar process
- [ ] Enabling with a missing path or endpoint does **not** crash the engine and reports `memory.health ok=false`
- [ ] With a real sidecar: settings page shows 已连接; speaking a fact then asking about it in a later turn answers from memory
- [ ] Locking the session (wake-word timeout) stops memory reads/writes; unlocking restores them
- [ ] `kill -9` the sidecar while the app runs: the next turn still answers, the settings page shows 降级, and a later turn reconnects (locked first)
- [ ] No absolute path, transcript text or memory content appears in voice logs or `memory.health` events

## Known gaps accepted for this iteration

1. **Provisioning is manual**: the sidecar venv (≈1.3 GB, 112 packages) and the E5
   model are not downloaded by the app. Packaging them behind a consent-driven
   download is the remaining work (`WIRING_PLAN.md` Step 5).
2. **License inventory** is now measurable but not yet a release gate.
   `experiments/voicemem/license_report.py` run against the sidecar venv reports
   **112 packages, 3 unresolved**: `kaldiio 2.18.1` (no metadata; upstream
   Apache-2.0), `tiktoken 0.14.0` (full MIT text, no short name) and
   `torch-complex 0.4.4` (`License: UNKNOWN`; upstream MIT). One copyleft entry
   exists, `soxr 1.1.0` (**LGPL-2.1-or-later**), but it is already in the app's
   wheelhouse license report, so it adds no new obligation beyond the LGPL terms
   (license text + relinking/source offer) if the sidecar venv is ever bundled.
3. **Single-process assumption**: one sidecar per memory root (mem0's local
   Qdrant limit). Two app instances sharing a userData directory would collide.
4. **Right brain excluded**: only facts are stored (`leftbrain_only`); the emotion
   graph stays off.
