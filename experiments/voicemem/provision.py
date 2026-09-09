#!/usr/bin/env python3
"""Prepare the memory sidecar environment reproducibly.

Creates a dedicated venv, installs voicemem at a pinned commit (PyPI only has
0.2.3, which lacks `llm_config`/`memory_language`), pins `httpx<1` because mem0
breaks on the 1.0 prereleases uv otherwise resolves, downloads the local E5
embedding model, and prints the exact settings to paste into the app.

Every step is idempotent and `--dry-run` prints the plan without touching
anything. This is the consent-driven provisioning path: nothing is downloaded
until the operator runs it.

    ./.venv/bin/python experiments/voicemem/provision.py --dry-run
    ./.venv/bin/python experiments/voicemem/provision.py --yes
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

#: voicemem git main pinned on 2026-09-05; see INTEGRATION_PLAN.md §1.
VOICEMEM_SHA = "a450911fc8cbb44c46d810aace2f3288bad287e4"
TARBALL_URL = f"https://codeload.github.com/xzf-thu/VoiceMem/tar.gz/{VOICEMEM_SHA}"
E5_MODEL = "intfloat/multilingual-e5-small"
DEFAULT_VENV = Path.home() / ".cache" / "speech-to-speech" / "voicemem-venv"
DEFAULT_MODELS = Path.home() / ".cache" / "speech-to-speech" / "voicemem-models"
REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Step:
    title: str
    command: list[str]
    skip: bool = False


def build_plan(*, venv: Path, models: Path, skip_models: bool, python: str = "3.11") -> list[Step]:
    steps = [
        Step(f"create venv {venv}", ["uv", "venv", str(venv), "--python", python]),
        Step(
            f"install voicemem@{VOICEMEM_SHA[:12]} (pinned tarball)",
            ["uv", "pip", "install", "--python", str(venv / "bin" / "python"), TARBALL_URL],
        ),
        Step(
            "pin httpx<1 (mem0 breaks on 1.0 prereleases)",
            ["uv", "pip", "install", "--python", str(venv / "bin" / "python"), "httpx<1"],
        ),
    ]
    if not skip_models:
        steps.append(
            Step(
                f"download {E5_MODEL} into {models}",
                [
                    str(venv / "bin" / "python"),
                    "-m",
                    "huggingface_hub.commands.huggingface_cli",
                    "download",
                    E5_MODEL,
                    "--local-dir",
                    str(models / "embedding"),
                ],
            )
        )
    return steps


def render_plan(steps: list[Step], *, venv: Path, models: Path) -> str:
    lines = ["memory sidecar provisioning plan:", ""]
    for index, step in enumerate(steps, start=1):
        lines.append(f"  {index}. {step.title}")
        lines.append(f"     $ {' '.join(step.command)}")
    lines += [
        "",
        "then paste these into the app's 长期记忆（实验） section:",
        f"  记忆解释器路径   {venv / 'bin' / 'python'}",
        f"  记忆 sidecar 脚本 {REPO_ROOT / 'experiments' / 'voicemem' / 'sidecar.py'}",
        "  抽取端点         http://127.0.0.1:8080/v1（本机服务）或云端 OpenAI 兼容地址",
        "  注入字符上限     1200",
        "",
        f"and export VOICEMEM_MODELS_DIR={models} for the sidecar process.",
    ]
    return "\n".join(lines)


def run(steps: list[Step]) -> int:
    for index, step in enumerate(steps, start=1):
        print(f"[{index}/{len(steps)}] {step.title}", flush=True)
        completed = subprocess.run(step.command, check=False)
        if completed.returncode != 0:
            print(f"FAILED: {' '.join(step.command)}", file=sys.stderr)
            return completed.returncode
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venv", type=Path, default=DEFAULT_VENV)
    parser.add_argument("--models", type=Path, default=DEFAULT_MODELS)
    parser.add_argument("--python", default="3.11")
    parser.add_argument("--skip-models", action="store_true", help="skip the E5 download")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and exit")
    parser.add_argument("--yes", action="store_true", help="run without an interactive prompt")
    args = parser.parse_args()

    if shutil.which("uv") is None:
        print("uv is required (https://docs.astral.sh/uv/)", file=sys.stderr)
        return 2

    steps = build_plan(venv=args.venv, models=args.models, skip_models=args.skip_models, python=args.python)
    print(render_plan(steps, venv=args.venv, models=args.models))
    if args.dry_run:
        return 0
    if not args.yes:
        answer = input("\nrun these steps now? [y/N] ").strip().lower()
        if answer not in {"y", "yes"}:
            print("aborted")
            return 1
    return run(steps)


if __name__ == "__main__":
    raise SystemExit(main())
