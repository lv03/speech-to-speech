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
| `session.py` | Batched write path: dedup (persisted), sensitive filter, debounce, worker thread |
| `prefetch.py` | Text-only speculative prefetch (`feed_partial` → `turn_over`) |
| `injection.py` | Gated per-response memory injection policy |
| `tests/test_adapter.py` | 15 mock-based tests for the adapter |
| `tests/test_pipeline.py` | 22 mock-based tests for batching, prefetch and injection |
| `check_env.py` | Gate 1: what a voicemem install would change here (zero-install) |
| `zh_smoke.py` | Gate 5: Chinese ingest/search smoke (needs the venv + a key) |
| `prefetch_probe.py` | Real prefetch timing probe (needs the venv + a key) |
| `config.example.env` | Env template: endpoint, language, mirror, storage, telemetry off |
| `INTEGRATION_NOTES.md` | What voicemem would introduce: deps, models, network, storage, risk |
| `GATES.md` | The seven gates: status, evidence, and the work each one still needs |
| `PRIOR_ART.md` | How qwen-audio-agent integrates VoiceMem, and what we should copy |
| `INTEGRATION_PLAN.md` | Upstream study, the shape decision, and staged progress |

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

The experiment tracks **voicemem git `main`**, pinned to commit
`a450911fc8cbb44c46d810aace2f3288bad287e4` (2026-09-05). PyPI only has 0.2.3,
which lacks `llm_config.py` / `lang.py` / `memory_language`. `git clone` is
throttled on this machine, so the tarball comes from `codeload.github.com`:

```bash
VENV="$HOME/.cache/speech-to-speech/voicemem-venv"
SHA=a450911fc8cbb44c46d810aace2f3288bad287e4
uv venv "$VENV" --python 3.11
curl -L -o /tmp/voicemem-main.tar.gz "https://codeload.github.com/xzf-thu/VoiceMem/tar.gz/$SHA"
uv pip install --python "$VENV/bin/python" /tmp/voicemem-main.tar.gz
uv pip install --python "$VENV/bin/python" "httpx<1"   # mem0 breaks on httpx 1.0 prereleases

set -a; . experiments/voicemem/config.example.env; set +a
"$VENV/bin/python" experiments/voicemem/zh_smoke.py --memory-root /tmp/voicemem-smoke
```

Keep the key out of shell history and chat: write it to a `chmod 600` file
outside the repo and source that file instead, e.g.
`~/.config/speech-to-speech/voicemem-smoke.env`.

Three settings the run proved necessary:

- `VOICEMEM_MEMORY_LANGUAGE=zh` — main defaults stored memory text to English,
  which silently produced `User lives in Taipei` and broke two of three queries.
- `HF_ENDPOINT` must be a **reachable** host (`hf-mirror.com` did not resolve
  here; `huggingface.co` did), and `HF_HUB_OFFLINE=1` once E5 is cached.
- `httpx<1`.

This is the one step that is **blocked without an OpenAI-compatible key**
(voicemem has no local fact-extraction path). The script prints counts, ids,
timings and booleans only — never transcript text. Result on 2026-09-08: PASS,
see `GATES.md`.

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
