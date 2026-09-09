from __future__ import annotations

import argparse
import logging
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

import numpy as np

from speech_to_speech.api.openai_realtime.audio_client import (
    RealtimeAudioClientConfig,
    load_realtime_tool_module,
    load_realtime_tool_modules,
    run_realtime_audio_client,
)
from speech_to_speech.pipeline.transcript_logging import (
    set_log_transcripts,
    warn_if_log_transcripts_enabled,
)
from speech_to_speech.security.voiceprint import (
    CONVERSATION_ENROLLMENT_PROTOCOL,
    SAMPLE_RATE,
    Voiceprint,
    VoiceprintProfile,
)
from speech_to_speech.security.wake_word import DEFAULT_WAKE_WORD

logger = logging.getLogger(__name__)

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
    parser.add_argument(
        "--playback-buffer-ms",
        type=float,
        default=defaults.playback_buffer_ms,
        help="Audio to buffer before playback starts, in milliseconds.",
    )
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
        "--log-transcripts",
        "--log_transcripts",
        dest="log_transcripts",
        action="store_true",
        default=defaults.log_transcripts,
        help="Write full Realtime transcript and tool error details to application logs.",
    )
    parser.add_argument(
        "--connection-retry-timeout",
        type=float,
        default=defaults.connection_retry_timeout_s,
        help="Seconds to wait for the Realtime endpoint to become available.",
    )
    parser.add_argument(
        "--memory-backend",
        dest="memory_backend",
        choices=("off", "voicemem"),
        default="off",
        help="Optional long-term memory backend. Off by default; voicemem requires its own venv and sidecar paths.",
    )
    parser.add_argument(
        "--memory-sidecar-python",
        dest="memory_sidecar_python",
        default=None,
        help="Interpreter that has voicemem installed (its own venv, never this runtime).",
    )
    parser.add_argument(
        "--memory-sidecar-script",
        dest="memory_sidecar_script",
        default=None,
        help="Path to the memory sidecar JSONL entry point.",
    )
    parser.add_argument(
        "--memory-root",
        dest="memory_root",
        default=None,
        help="App-private directory for the memory store.",
    )
    parser.add_argument(
        "--memory-max-chars",
        dest="memory_max_chars",
        type=int,
        default=1200,
        help="Maximum characters of the memory block injected into a response.",
    )
    namespace = parser.parse_args(list(argv))
    tools: list[dict[str, Any]] = []
    tool_executor = None
    tool_response_create = defaults.tool_response_create
    if namespace.tool_module:
        module_names = [name.strip() for name in namespace.tool_module.split(",")]
        if len(module_names) == 1:
            tools, tool_executor, tool_response_create = load_realtime_tool_module(module_names[0])
        else:
            tools, tool_executor, tool_response_create = load_realtime_tool_modules(module_names)
    return RealtimeAudioClientConfig(
        url=namespace.url,
        model=namespace.model,
        api_key=namespace.api_key,
        send_rate=namespace.send_rate,
        recv_rate=namespace.recv_rate,
        playback_buffer_ms=namespace.playback_buffer_ms,
        chunk_size=namespace.chunk_size,
        input_device=namespace.input_device,
        output_device=namespace.output_device,
        instructions=namespace.instructions,
        voice=namespace.voice,
        print_json=namespace.print_json,
        block_mic_during_playback=namespace.block_mic_during_playback,
        log_transcripts=namespace.log_transcripts,
        connection_retry_timeout_s=namespace.connection_retry_timeout,
        tools=tools,
        tool_executor=tool_executor,
        tool_response_create=tool_response_create,
        # `talk` has no wake-word gate, so the explicit CLI opt-in is the permission.
        memory_provider=_build_memory_provider(namespace, unlocked=True),
    )


def _build_memory_provider(namespace: argparse.Namespace, *, unlocked: bool = False):
    """Build the optional memory provider. Returns None unless explicitly enabled.

    ``unlocked`` mirrors the security gate. Callers that own a wake-word gate must
    leave it False and unlock the provider from the gate callback instead.
    """
    backend = getattr(namespace, "memory_backend", "off")
    if backend == "off":
        return None
    from speech_to_speech.memory import MemoryConfig, MemoryProvider

    provider = MemoryProvider(
        MemoryConfig(
            backend=backend,
            sidecar_python=namespace.memory_sidecar_python,
            sidecar_script=namespace.memory_sidecar_script,
            memory_root=namespace.memory_root,
            max_context_chars=int(namespace.memory_max_chars),
        )
    )
    started = provider.start()
    if not started:
        logger.warning(
            "Memory backend %s is enabled but the sidecar did not start: %s",
            backend,
            provider.degraded_reason or "unknown",
        )
    elif unlocked:
        provider.set_unlocked(True)
    return provider


def _default_voiceprint_path(name: str | None) -> Path:
    directory = Path.home() / ".cache" / "speech_to_speech" / "voiceprint"
    return directory / f"{name or 'default'}.npz"


_VOICEPRINT_ENROLLMENT_PROMPTS = (
    "今天天气不错，我正在测试自己的声音。",
    "请只让系统响应我说出的语音指令。",
    "这段录音用于建立本地声纹识别档案。",
    "我会用正常的速度和音量继续说话。",
    "现在完成最后一段自然语音注册录音。",
)


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


def _voiceprint_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="speech-to-speech voiceprint",
        description="Enroll or verify a speaker voiceprint (3D-Speaker ERes2NetV2).",
    )
    subparsers = parser.add_subparsers(dest="action", metavar="ACTION", required=True)
    enroll_parser = subparsers.add_parser("enroll", help="Record microphone takes and save a voiceprint profile.")
    enroll_parser.add_argument("--name", default="default", help="Profile name (used in the default output path).")
    enroll_parser.add_argument("--takes", type=int, default=5, help="Number of enrollment takes. Default is 5.")
    enroll_parser.add_argument("--take-duration", type=float, default=4.0, help="Seconds per take, between 2 and 10. Default is 4.0.")
    enroll_parser.add_argument(
        "--wake-word",
        default=DEFAULT_WAKE_WORD,
        help="Wake word used by the security gate (stored as profile metadata). Default is 你好，噜噜.",
    )
    enroll_parser.add_argument("--output", type=Path, default=None, help="Output .npz path.")
    verify_parser = subparsers.add_parser("verify", help="Record one take and score it against a profile.")
    verify_parser.add_argument("--profile", type=Path, default=None, help="Profile path. Defaults to the default profile.")
    verify_parser.add_argument("--threshold", type=float, default=None, help="Acceptance threshold for the verdict.")
    info_parser = subparsers.add_parser("info", help="Show a stored profile's metadata.")
    info_parser.add_argument("--profile", type=Path, default=None, help="Profile path. Defaults to the default profile.")
    info_parser.add_argument("--json", action="store_true", help="Output machine-readable JSON instead of text.")
    return parser


def _run_voiceprint_enroll(namespace: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    if namespace.takes < 1:
        parser.error("--takes must be at least 1")
    if not 2.0 <= namespace.take_duration <= 10.0:
        parser.error("--take-duration must be between 2.0 and 10.0 seconds")
    output = namespace.output or _default_voiceprint_path(namespace.name)
    print(f"声纹注册：将录 {namespace.takes} 段自然说话（每段 {namespace.take_duration:.0f} 秒）")
    extractor = Voiceprint()
    takes: list[np.ndarray] = []
    for index in range(1, namespace.takes + 1):
        prompt = _VOICEPRINT_ENROLLMENT_PROMPTS[(index - 1) % len(_VOICEPRINT_ENROLLMENT_PROMPTS)]
        print(f"\n第 {index}/{namespace.takes} 次：请在倒计时结束后自然朗读下面这句话")
        print(f"  「{prompt}」")
        takes.append(_record_voiceprint_take(namespace.take_duration))
    profile = extractor.enroll(
        takes,
        wake_word=namespace.wake_word,
        enrollment_protocol=CONVERSATION_ENROLLMENT_PROTOCOL,
    )
    profile.save(output)
    print(f"\n注册完成，已保存到 {output}")


def _print_voiceprint_info(profile: VoiceprintProfile, profile_path: Path, as_json: bool) -> None:
    if as_json:
        import json

        print(
            json.dumps(
                {
                    "enrolled": True,
                    "path": str(profile_path),
                    "model": profile.model_name,
                    "wake_word": profile.wake_word,
                    "takes": profile.takes,
                    "total_duration_s": profile.total_duration_s,
                    "schema_version": profile.schema_version,
                    "enrollment_protocol": profile.enrollment_protocol,
                    "supports_continuous_gating": profile.supports_conversation_gate,
                },
                ensure_ascii=False,
            )
        )
        return
    print(f"档案: {profile_path}")
    print(f"  模型: {profile.model_name}")
    print(f"  唤醒词: {profile.wake_word}")
    print(f"  注册遍数: {profile.takes}")
    print(f"  累计语音时长: {profile.total_duration_s:.1f}s")
    print(f"  档案版本: {profile.schema_version}")
    print(f"  注册协议: {profile.enrollment_protocol}")
    print(f"  支持持续声纹门控: {'是' if profile.supports_conversation_gate else '否（需重新注册）'}")
    print(f"  创建时间: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(profile.created_at))}")


def _run_voiceprint_verify(namespace: argparse.Namespace, profile_path: Path) -> None:
    profile = VoiceprintProfile.load(profile_path)
    threshold = namespace.threshold if namespace.threshold is not None else 0.75
    print("声纹验证：请在倒计时结束后自然说话")
    audio = _record_voiceprint_take(4.0)
    embedding = Voiceprint(model_name=profile.model_name).embed(audio)
    score = profile.score(embedding)
    verdict = "通过 ✅" if score >= threshold else "拒绝 ❌"
    print(f"\n相似度: {score:.4f}（阈值 {threshold:.2f}）→ {verdict}")


def run_voiceprint_command(command_args: list[str]) -> None:
    """Handle the ``speech-to-speech voiceprint`` subcommand family."""
    parser = _voiceprint_parser()
    namespace = parser.parse_args(command_args)

    if namespace.action == "enroll":
        _run_voiceprint_enroll(namespace, parser)
        return

    profile_path = namespace.profile or _default_voiceprint_path(None)
    if not Path(profile_path).is_file():
        parser.error(f"声纹档案不存在: {profile_path}（先用 `speech-to-speech voiceprint enroll` 注册）")

    if namespace.action == "info":
        _print_voiceprint_info(
            VoiceprintProfile.load(profile_path),
            profile_path,
            bool(getattr(namespace, "json", False)),
        )
        return

    if namespace.action == "verify":
        _run_voiceprint_verify(namespace, Path(profile_path))
        return

    parser.error(f"unknown action {namespace.action!r}")


def main() -> None:
    command, command_args = parse_command()
    if command == "talk":
        config = parse_talk_arguments(command_args)
        set_log_transcripts(config.log_transcripts)
        warn_if_log_transcripts_enabled()
        run_realtime_audio_client(config)
        return
    if command == "voiceprint":
        run_voiceprint_command(command_args)
        return

    from speech_to_speech.s2s_pipeline import run_pipeline_command

    run_pipeline_command(command, command_args)


if __name__ == "__main__":
    main()
