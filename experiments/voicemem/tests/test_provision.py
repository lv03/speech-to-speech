"""Provisioning plan tests: the plan is the contract, nothing is executed."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from provision import (  # noqa: E402
    E5_MODEL,
    QWEN3_GGUF_NAME,
    TARBALL_URL,
    VOICEMEM_SHA,
    build_plan,
    render_plan,
)


def test_plan_pins_the_commit_and_the_httpx_fix(tmp_path):
    steps = build_plan(venv=tmp_path / "venv", models=tmp_path / "models", skip_models=False)
    commands = [" ".join(step.command) for step in steps]

    assert any(VOICEMEM_SHA in command and TARBALL_URL in command for command in commands)
    assert any(command.endswith("httpx<1") for command in commands)
    assert any(E5_MODEL in command for command in commands)
    # The venv is created with uv, never with the repository interpreter.
    assert commands[0].startswith("uv venv")


def test_skip_models_drops_the_download_step(tmp_path):
    steps = build_plan(venv=tmp_path / "venv", models=tmp_path / "models", skip_models=True)
    assert not any(E5_MODEL in " ".join(step.command) for step in steps)


def test_render_lists_every_step_and_the_settings_to_paste(tmp_path):
    venv = tmp_path / "venv"
    models = tmp_path / "models"
    steps = build_plan(venv=venv, models=models, skip_models=False)
    text = render_plan(steps, venv=venv, models=models)

    for step in steps:
        assert step.title in text
    assert str(venv / "bin" / "python") in text
    assert "sidecar.py" in text
    assert str(models) in text


def test_dry_run_creates_nothing(tmp_path, capsys):
    import provision

    venv = tmp_path / "venv"
    models = tmp_path / "models"
    sys.argv = [
        "provision.py",
        "--venv",
        str(venv),
        "--models",
        str(models),
        "--dry-run",
    ]
    try:
        assert provision.main() == 0
    finally:
        sys.argv = sys.argv[:1]

    assert not venv.exists()
    assert not models.exists()
    out = capsys.readouterr().out
    assert VOICEMEM_SHA[:12] in out


def test_llama_cpp_plan_builds_metal_and_skips_the_e5_download(tmp_path):
    steps = build_plan(
        venv=tmp_path / "venv",
        models=tmp_path / "models",
        skip_models=False,
        embedder="llama-cpp",
    )
    commands = [" ".join(step.command) for step in steps]

    assert any("CMAKE_ARGS=-DGGML_METAL=on" in command and "llama-cpp-python" in command for command in commands)
    assert not any(E5_MODEL in command for command in commands)


def test_llama_cpp_plan_tells_the_operator_which_env_to_export(tmp_path):
    venv, models = tmp_path / "venv", tmp_path / "models"
    text = render_plan(
        build_plan(venv=venv, models=models, skip_models=False, embedder="llama-cpp"),
        venv=venv,
        models=models,
        embedder="llama-cpp",
    )
    assert "S2S_MEMORY_EMBEDDER=llama-cpp" in text
    assert QWEN3_GGUF_NAME in text
