# experiments/voicemem — Phase 5 pre-research (NOT part of v1)

VoiceMem is a **post-v1, optional experiment** in the KB baseline
(`docs/kb-memory-integration-proposal.md` §10). This directory exists to answer
the seven Phase 5 gates **without** pulling voicemem into the product: nothing
under `src/`, `desktop/` or `gateway/` imports it, and voicemem itself is
imported lazily so the repository's own environment never needs the 112
packages it drags in.

## Files

| File | Purpose |
|---|---|
| `adapter.py` | The three fixed interfaces over a memory backend, fail-closed |
| `tests/test_adapter.py` | 15 mock-based tests; no voicemem install needed |
| `check_env.py` | Gate 1: what a voicemem install would change here (zero-install) |
| `zh_smoke.py` | Gate 5: Chinese ingest/search smoke (needs the venv + a key) |
| `config.example.env` | Env template: endpoint, mirror, app-private storage, telemetry off |
| `INTEGRATION_NOTES.md` | What voicemem would introduce: deps, models, network, storage, risk |
| `GATES.md` | The seven gates: status, evidence, and the work each one still needs |
| `PRIOR_ART.md` | How qwen-audio-agent integrates VoiceMem, and what we should copy |

## Run the tests (no install, ~0.02 s)

```bash
PYTHONPATH=.:src ./.venv/bin/python -m pytest experiments/voicemem/tests -q
```

CI is scoped to `tests/` (`.github/workflows/ci.yml` runs `uv run pytest tests/ -x -q`),
so these stay opt-in and never couple the v1 suite to the experiment. A bare
local `pytest -q` will collect them; they are dependency-free.

## Check what an install would do (no install, no download)

```bash
./.venv/bin/python experiments/voicemem/check_env.py --python .venv/bin/python
```

Point `--python` at a fresh venv to see the full closure instead of the delta.

## Run the Chinese smoke (requires the venv and a key)

```bash
VENV="$HOME/.cache/speech-to-speech/voicemem-venv"
uv venv "$VENV" --python 3.11
uv pip install --python "$VENV/bin/python" voicemem
uv pip install --python "$VENV/bin/python" "httpx<1"   # mem0 breaks on httpx 1.0 prereleases

set -a; . experiments/voicemem/config.example.env; set +a
"$VENV/bin/python" experiments/voicemem/zh_smoke.py --memory-root /tmp/voicemem-smoke
```

Keep the key out of shell history and chat: write it to a `chmod 600` file
outside the repo and source that file instead, e.g.
`~/.config/speech-to-speech/voicemem-smoke.env`.

Set `HF_ENDPOINT` to a **reachable** host: on 2026-09-08 `hf-mirror.com` did not
resolve here and `https://huggingface.co` did.

This is the one step that is **blocked without an OpenAI-compatible key**
(voicemem 0.2.3 has no local fact-extraction path). The script prints counts,
ids, timings and booleans only — never transcript text. Result on 2026-09-08:
PASS, see `GATES.md`.

## Non-negotiables carried by the adapter

- `memory_root` must be explicit and app-private (voicemem otherwise writes into
  the process working directory).
- Reads and writes require an unlocked session (`set_permission(...)`); the
  default reports locked.
- Cloud extraction requires `allow_cloud_extraction=True`; without it the
  adapter stays inert rather than uploading silently.
- Only final transcriptions are accepted, deduplicated by
  `(turn_id, turn_revision)`.
- `MEM0_TELEMETRY` is forced to `false` (mem0 defaults it on).

## What is explicitly out of scope

- Wiring the adapter into the voice process, the tool list, or the desktop app.
- The right-brain emotion graph (v1 excludes it; `audio_native=False`).
- Production packaging, model provisioning, license review for the new deps.
