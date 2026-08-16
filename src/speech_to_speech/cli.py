from __future__ import annotations

import argparse
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

import numpy as np

from speech_to_speech.api.openai_realtime.audio_client import (
    RealtimeAudioClientConfig,
    load_realtime_tool_module,
    run_realtime_audio_client,
)
from speech_to_speech.security.voiceprint import SAMPLE_RATE, Voiceprint, VoiceprintProfile
from speech_to_speech.security.wake_word import DEFAULT_WAKE_WORD, crop_last_speech_burst

Command = Literal["serve", "talk", "local", "voiceprint"]

_LEGACY_MODE_COMMANDS: dict[str, Command] = {
    "realtime": "serve",
    "local": "local",
}


def _command_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="speech-to-speech",
        description="Run or connect to the Realtime speech-to-speech pipeline.",
    )
    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")
    subparsers.add_parser("serve", add_help=False, help="Run the Realtime pipeline server.")
    subparsers.add_parser("talk", add_help=False, help="Connect microphone and speakers to a Realtime URL.")
    subparsers.add_parser("local", add_help=False, help="Run the server and audio client together over loopback.")
    subparsers.add_parser("voiceprint", add_help=False, help="Enroll or verify a speaker voiceprint.")
    return parser


def _extract_legacy_mode(command_args: list[str], parser: argparse.ArgumentParser) -> tuple[str | None, list[str]]:
    """Remove one legacy ``--mode`` option without parsing command-owned flags."""

    mode: str | None = None
    remaining: list[str] = []
    index = 0
    while index < len(command_args):
        argument = command_args[index]
        if argument == "--mode":
            if mode is not None:
                parser.error("--mode may only be specified once")
            if index + 1 == len(command_args) or command_args[index + 1].startswith("-"):
                parser.error("--mode requires a value: realtime or local")
            mode = command_args[index + 1]
            index += 2
            continue
        if argument.startswith("--mode="):
            if mode is not None:
                parser.error("--mode may only be specified once")
            mode = argument.partition("=")[2]
            if not mode:
                parser.error("--mode requires a value: realtime or local")
            index += 1
            continue
        remaining.append(argument)
        index += 1
    return mode, remaining


def parse_command(argv: Sequence[str] | None = None) -> tuple[Command, list[str]]:
    """Split the top-level command from arguments owned by that command."""

    command_args = list(sys.argv[1:] if argv is None else argv)
    parser = _command_parser()
    if not command_args:
        parser.error("a command is required: serve, talk, or local")
    if command_args[0] in {"-h", "--help"}:
        parser.print_help()
        raise SystemExit(0)
    if command_args[0] not in {"serve", "talk", "local", "voiceprint"}:
        legacy_mode, remaining = _extract_legacy_mode(command_args, parser)
        if legacy_mode is not None:
            legacy_command = _LEGACY_MODE_COMMANDS.get(legacy_mode)
            if legacy_command is None:
                parser.error(
                    f"--mode {legacy_mode!r} is no longer supported; only 'realtime' and 'local' remain "
                    "temporarily. Use 'speech-to-speech serve' or 'speech-to-speech local' instead."
                )
            print(
                f"Warning: '--mode {legacy_mode}' is deprecated and will stop working soon; "
                f"use 'speech-to-speech {legacy_command}' instead.",
                file=sys.stderr,
            )
            return legacy_command, remaining
    command = command_args[0]
    if command not in {"serve", "talk", "local", "voiceprint"}:
        parser.error(f"unknown command {command!r}; choose serve, talk, local, or voiceprint")
    return command, command_args[1:]  # type: ignore[return-value]


def parse_talk_arguments(argv: Sequence[str]) -> RealtimeAudioClientConfig:
    """Parse the lightweight audio client command."""

    defaults = RealtimeAudioClientConfig()
    parser = argparse.ArgumentParser(
        prog="speech-to-speech talk",
        description="Connect microphone and speakers to an OpenAI-compatible Realtime endpoint.",
    )
    parser.add_argument(
        "--url",
        default=defaults.url,
        help="Full Realtime WebSocket endpoint, including /realtime.",
    )
    parser.add_argument("--model", default=defaults.model)
    parser.add_argument(
        "--api-key",
        default=defaults.api_key,
        help=(
            "Realtime API key. Defaults to OPENAI_API_KEY, or a harmless placeholder for an unauthenticated "
            "loopback endpoint."
        ),
    )
    parser.add_argument("--send-rate", type=int, default=defaults.send_rate)
    parser.add_argument("--recv-rate", type=int, default=defaults.recv_rate)
    parser.add_argument("--chunk-size", type=int, default=defaults.chunk_size)
    parser.add_argument("--input-device", type=int, default=defaults.input_device)
    parser.add_argument("--output-device", type=int, default=defaults.output_device)
    parser.add_argument("--instructions", default=defaults.instructions)
    parser.add_argument(
        "--tool-module",
        help="Importable module defining TOOLS and async execute_tool(name, arguments).",
    )
    parser.add_argument(
        "--voice",
        default=defaults.voice,
        help="session.audio.output.voice (for example bm_fable, marin, or alloy).",
    )
    parser.add_argument("--print-json", action="store_true", default=defaults.print_json)
    parser.add_argument(
        "--block-mic-during-playback",
        action="store_true",
        default=defaults.block_mic_during_playback,
    )
    parser.add_argument(
        "--connection-retry-timeout",
        type=float,
        default=defaults.connection_retry_timeout_s,
        help="Seconds to wait for the Realtime endpoint to become available.",
    )
    namespace = parser.parse_args(list(argv))
    tools: list[dict[str, Any]] = []
    tool_executor = None
    tool_response_create = defaults.tool_response_create
    if namespace.tool_module:
        tools, tool_executor, tool_response_create = load_realtime_tool_module(namespace.tool_module)
    return RealtimeAudioClientConfig(
        url=namespace.url,
        model=namespace.model,
        api_key=namespace.api_key,
        send_rate=namespace.send_rate,
        recv_rate=namespace.recv_rate,
        chunk_size=namespace.chunk_size,
        input_device=namespace.input_device,
        output_device=namespace.output_device,
        instructions=namespace.instructions,
        voice=namespace.voice,
        print_json=namespace.print_json,
        block_mic_during_playback=namespace.block_mic_during_playback,
        connection_retry_timeout_s=namespace.connection_retry_timeout,
        tools=tools,
        tool_executor=tool_executor,
        tool_response_create=tool_response_create,
    )


def _default_voiceprint_path(name: str | None) -> Path:
    directory = Path.home() / ".cache" / "speech_to_speech" / "voiceprint"
    return directory / f"{name or 'default'}.npz"


def _record_voiceprint_take(duration_s: float = 2.5) -> np.ndarray:
    """Record one microphone take at 16 kHz mono and return float32 samples."""
    import sounddevice as sd

    for second in (3, 2, 1):
        print(f"  {second}...", flush=True)
        time.sleep(1.0)
    print("  录音中...", flush=True)
    recording = sd.rec(int(duration_s * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="int16")
    sd.wait()
    audio = recording.squeeze().astype(np.float32) / 32768.0
    duration = len(audio) / SAMPLE_RATE
    peak = float(np.abs(audio).max())
    print(f"  完成（{duration:.1f}s，峰值 {peak:.2f}）", flush=True)
    return audio


def run_voiceprint_command(command_args: list[str]) -> None:
    """Handle the ``speech-to-speech voiceprint`` subcommand family."""
    parser = argparse.ArgumentParser(
        prog="speech-to-speech voiceprint",
        description="Enroll or verify a speaker voiceprint (3D-Speaker ERes2NetV2).",
    )
    subparsers = parser.add_subparsers(dest="action", metavar="ACTION", required=True)
    enroll_parser = subparsers.add_parser("enroll", help="Record microphone takes and save a voiceprint profile.")
    enroll_parser.add_argument("--name", default="default", help="Profile name (used in the default output path).")
    enroll_parser.add_argument("--takes", type=int, default=3, help="Number of enrollment takes. Default is 3.")
    enroll_parser.add_argument("--wake-word", default=DEFAULT_WAKE_WORD, help="Wake word to record. Default is 噜噜噜噜.")
    enroll_parser.add_argument("--output", type=Path, default=None, help="Output .npz path.")
    verify_parser = subparsers.add_parser("verify", help="Record one take and score it against a profile.")
    verify_parser.add_argument("--profile", type=Path, default=None, help="Profile path. Defaults to the default profile.")
    verify_parser.add_argument("--threshold", type=float, default=None, help="Acceptance threshold for the verdict.")
    info_parser = subparsers.add_parser("info", help="Show a stored profile's metadata.")
    info_parser.add_argument("--profile", type=Path, default=None, help="Profile path. Defaults to the default profile.")

    namespace = parser.parse_args(command_args)

    if namespace.action == "enroll":
        if namespace.takes < 1:
            parser.error("--takes must be at least 1")
        output = namespace.output or _default_voiceprint_path(namespace.name)
        print(f"声纹注册：将录 {namespace.takes} 遍唤醒词「{namespace.wake_word}」")
        extractor = Voiceprint()
        takes: list[np.ndarray] = []
        for index in range(1, namespace.takes + 1):
            print(f"\n第 {index}/{namespace.takes} 次：请在倒计时结束后说出「{namespace.wake_word}」")
            # Crop each take with the same energy trim the live gate uses, so
            # enrollment and verification embed the same kind of audio.
            takes.append(crop_last_speech_burst(_record_voiceprint_take()))
        profile = extractor.enroll(takes, wake_word=namespace.wake_word)
        profile.save(output)
        print(f"\n注册完成，已保存到 {output}")
        return

    profile_path = namespace.profile or _default_voiceprint_path(None)
    if not Path(profile_path).is_file():
        parser.error(f"声纹档案不存在: {profile_path}（先用 `speech-to-speech voiceprint enroll` 注册）")

    if namespace.action == "info":
        profile = VoiceprintProfile.load(profile_path)
        print(f"档案: {profile_path}")
        print(f"  模型: {profile.model_name}")
        print(f"  唤醒词: {profile.wake_word}")
        print(f"  注册遍数: {profile.takes}")
        print(f"  创建时间: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(profile.created_at))}")
        return

    if namespace.action == "verify":
        profile = VoiceprintProfile.load(profile_path)
        threshold = namespace.threshold if namespace.threshold is not None else 0.75
        print(f"声纹验证：请说出「{profile.wake_word}」")
        audio = crop_last_speech_burst(_record_voiceprint_take())
        embedding = Voiceprint(model_name=profile.model_name).embed(audio)
        score = profile.score(embedding)
        verdict = "通过 ✅" if score >= threshold else "拒绝 ❌"
        print(f"\n相似度: {score:.4f}（阈值 {threshold:.2f}）→ {verdict}")
        return

    parser.error(f"unknown action {namespace.action!r}")


def main() -> None:
    command, command_args = parse_command()
    if command == "talk":
        run_realtime_audio_client(parse_talk_arguments(command_args))
        return
    if command == "voiceprint":
        run_voiceprint_command(command_args)
        return

    from speech_to_speech.s2s_pipeline import run_pipeline_command

    run_pipeline_command(command, command_args)


if __name__ == "__main__":
    main()
