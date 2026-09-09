import argparse
import json
import logging
import os
import signal
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from sys import platform
from threading import Event
from types import FrameType
from typing import Any, Literal, Optional, Sequence

import nltk
import torch
from rich.console import Console
from transformers import HfArgumentParser

from speech_to_speech.api.audio_api import AudioApiConfig
from speech_to_speech.arguments_classes.local_audio_arguments import LocalAudioArguments
from speech_to_speech.arguments_classes.module_arguments import ModuleArguments
from speech_to_speech.arguments_classes.realtime_server_arguments import (
    LocalRealtimeServerArguments,
    RealtimeServerArguments,
)
from speech_to_speech.arguments_classes.vad_arguments import VADHandlerArguments
from speech_to_speech.backend_registry import (
    LLM_BACKENDS,
    STT_BACKENDS,
    TTS_BACKENDS,
    BackendSelection,
    BackendSpec,
)
from speech_to_speech.pipeline.transcript_logging import (
    set_log_transcripts,
    warn_if_log_transcripts_enabled,
)
from speech_to_speech.pipeline_graph import PipelineGraph
from speech_to_speech.utils.thread_manager import ThreadManager

# Ensure the nltk Punkt resource used as the sent_tokenize fallback is present.
# (Multilingual splitting prefers wtpsplit/SaT; see LLM/utils.py. The old
# averaged_perceptron_tagger_eng download was never used and is dropped.)
try:
    nltk.data.find("tokenizers/punkt_tab")
except (LookupError, OSError):
    nltk.download("punkt_tab")

# caching allows ~50% compilation time reduction
# see https://docs.google.com/document/d/1y5CRfMLdwEoF1nTk9q8qEu1mgMUuUtvhklPKJ2emLU8/edit#heading=h.o2asbxsrp1ma
CURRENT_DIR = Path(__file__).resolve().parent
os.environ["TORCHINDUCTOR_CACHE_DIR"] = os.path.join(CURRENT_DIR, "tmp")

console = Console()
logger = logging.getLogger(__name__)
logging.getLogger("numba").setLevel(logging.WARNING)  # quiet down numba logs

MLX_DEFAULT_LM_MODEL = "mlx-community/Qwen3-4B-Instruct-2507-bf16"
OPENAI_TTS_PLAYBACK_BUFFER_MS = 196.0


def _mac_preset_defaults(llm_backend: str) -> dict[str, Any]:
    """Return macOS parser defaults, leaving explicit arguments free to override them."""

    defaults: dict[str, Any] = {
        "stt": "parakeet-tdt",
        "llm_backend": "mlx-lm",
        "tts": "qwen3",
        "stt_device": "mps",
        "paraformer_stt_device": "mps",
        "fun_asr_nano_stt_device": "mps",
        "facebook_mms_device": "mps",
        "qwen3_tts_device": "mps",
    }
    if llm_backend not in {"responses-api", "chat-completions"}:
        defaults["llm_device"] = "mps"
        if llm_backend == "mlx-lm":
            defaults["model_name"] = MLX_DEFAULT_LM_MODEL
    return defaults


@dataclass
class ParsedArguments:
    module_kwargs: ModuleArguments
    realtime_server_kwargs: RealtimeServerArguments
    local_audio_kwargs: LocalAudioArguments
    vad_handler_kwargs: VADHandlerArguments
    stt_backend: BackendSelection
    llm_backend: BackendSelection
    tts_backend: BackendSelection


@dataclass(frozen=True)
class BackendPreselection:
    mac_preset_enabled: bool
    pipeline_json: dict[str, Any] | None
    stt_name: str
    llm_name: str
    tts_name: str


def build_llm_proxy_config(
    module_kwargs: ModuleArguments,
    llm_backend: BackendSelection,
) -> Any:
    """Build proxy settings from the selected LLM's normalized configuration."""
    from speech_to_speech.api.openai_realtime.llm_proxy import LLMProxyConfig

    if not llm_backend.spec.capabilities.supports_llm_proxy:
        supported = ", ".join(name for name, spec in LLM_BACKENDS.items() if spec.capabilities.supports_llm_proxy)
        raise ValueError(
            f"The LLM proxy requires a backend with proxy support; choose one of: {supported}. "
            f"Got {llm_backend.name!r}."
        )
    config = llm_backend.config
    return LLMProxyConfig(
        enabled=module_kwargs.enable_llm_proxy,
        llm_backend=module_kwargs.llm_backend,
        upstream_base_url=config["base_url"],
        upstream_api_key=config["api_key"],
        model_name=config["model_name"],
        connect_timeout_s=module_kwargs.llm_proxy_connect_timeout_s,
    )


def _parse_selected_cli_configs(
    parser: HfArgumentParser,
    pipeline_args: list[str],
    selected_specs: Sequence[BackendSpec],
) -> tuple[Any, ...]:
    """Parse selected configs while accepting legacy options for inactive backends."""

    *parsed, remaining = parser.parse_args_into_dataclasses(
        args=pipeline_args,
        return_remaining_strings=True,
    )
    if not remaining:
        return tuple(parsed)

    selected_types = {spec.config_type for spec in selected_specs}
    inactive_types: list[type[Any]] = []
    for registry in (STT_BACKENDS, LLM_BACKENDS, TTS_BACKENDS):
        for spec in registry.values():
            if spec.config_type not in selected_types and spec.config_type not in inactive_types:
                inactive_types.append(spec.config_type)

    compatibility_parser = HfArgumentParser(
        tuple(inactive_types),  # type: ignore[arg-type]
        add_help=False,
        allow_abbrev=False,
        conflict_handler="resolve",
    )
    known_options = compatibility_parser._option_string_actions
    _, unknown = compatibility_parser.parse_known_args(remaining)
    if unknown:
        raise ValueError(f"Some specified arguments are not used by the HfArgumentParser: {unknown}")

    ignored_options = sorted({token.split("=", 1)[0] for token in remaining if token.split("=", 1)[0] in known_options})
    logger.warning(
        "Ignoring options for inactive backends: %s",
        ", ".join(ignored_options),
    )
    return tuple(parsed)


def _resolve_backend_names(
    pipeline_args: list[str],
    module_defaults: ModuleArguments,
    command: Literal["serve", "local"],
) -> BackendPreselection:
    """Resolve selected backend names before the full dataclass parse."""

    if len(pipeline_args) == 1 and pipeline_args[0].endswith(".json"):
        with open(pipeline_args[0]) as _f:
            pipeline_json = json.load(_f)
        mac_preset_enabled = bool(pipeline_json.get("mac_optimal_settings", False))
        llm_name = pipeline_json.get("llm_backend") or (
            "mlx-lm" if mac_preset_enabled else module_defaults.llm_backend
        )
        if mac_preset_enabled:
            pipeline_json = {**_mac_preset_defaults(llm_name), **pipeline_json}
        return BackendPreselection(
            mac_preset_enabled=mac_preset_enabled,
            pipeline_json=pipeline_json,
            stt_name=pipeline_json.get("stt") or module_defaults.stt,
            llm_name=llm_name,
            tts_name=pipeline_json.get("tts") or module_defaults.tts,
        )

    pre = argparse.ArgumentParser(prog=f"speech-to-speech {command}", add_help=False)
    pre.add_argument("--mac-optimal-settings", action="store_true")
    pre.add_argument("--stt", choices=tuple(STT_BACKENDS))
    pre.add_argument("--llm_backend", "--llm-backend", choices=tuple(LLM_BACKENDS))
    pre.add_argument("--tts", choices=tuple(TTS_BACKENDS))
    pre_args = pre.parse_known_args(pipeline_args)[0]
    mac_preset_enabled = pre_args.mac_optimal_settings
    stt_name = pre_args.stt or module_defaults.stt
    llm_name = pre_args.llm_backend or ("mlx-lm" if mac_preset_enabled else module_defaults.llm_backend)
    tts_name = pre_args.tts or module_defaults.tts
    return BackendPreselection(
        mac_preset_enabled=mac_preset_enabled,
        pipeline_json=None,
        stt_name=stt_name,
        llm_name=llm_name,
        tts_name=tts_name,
    )


def _select_backend_specs(preselection: BackendPreselection) -> list[BackendSpec]:
    selected_specs = []
    for registry, name in (
        (STT_BACKENDS, preselection.stt_name),
        (LLM_BACKENDS, preselection.llm_name),
        (TTS_BACKENDS, preselection.tts_name),
    ):
        try:
            selected_specs.append(registry[name])
        except KeyError as exc:
            choices = ", ".join(registry)
            raise ValueError(f"Unsupported backend {name!r}; choose one of: {choices}.") from exc
    return selected_specs


def _argument_classes_for_command(command: Literal["serve", "local"], selected_specs: Sequence[BackendSpec]) -> list[type[Any]]:
    classes: list[type[Any]] = [
        ModuleArguments,
        RealtimeServerArguments if command == "serve" else LocalRealtimeServerArguments,
    ]
    if command == "local":
        classes.append(LocalAudioArguments)
    classes.extend(
        [
            VADHandlerArguments,
            *(spec.config_type for spec in selected_specs),
        ]
    )
    return classes


def _build_argument_parser(
    command: Literal["serve", "local"],
    selected_specs: Sequence[BackendSpec],
    preselection: BackendPreselection,
) -> HfArgumentParser:
    parser = HfArgumentParser(
        tuple(_argument_classes_for_command(command, selected_specs)),
        prog=f"speech-to-speech {command}",
    )  # type: ignore[arg-type]
    mac_action = parser._option_string_actions.pop("--mac_optimal_settings")
    mac_action.option_strings = [option for option in mac_action.option_strings if option != "--mac_optimal_settings"]
    if preselection.mac_preset_enabled:
        parser.set_defaults(**_mac_preset_defaults(preselection.llm_name))
    return parser


def _parse_pipeline_dataclasses(
    parser: HfArgumentParser,
    pipeline_args: list[str],
    selected_specs: Sequence[BackendSpec],
    preselection: BackendPreselection,
) -> tuple[Any, ...]:
    if preselection.pipeline_json is not None:
        return tuple(parser.parse_dict(preselection.pipeline_json, allow_extra_keys=True))
    return _parse_selected_cli_configs(parser, pipeline_args, selected_specs)


def _server_args_from_parsed(
    command: Literal["serve", "local"],
    by_type: dict[type, Any],
) -> RealtimeServerArguments:
    if command == "serve":
        return by_type[RealtimeServerArguments]
    return RealtimeServerArguments(
        host="127.0.0.1",
        port=by_type[LocalRealtimeServerArguments].port,
    )


def _assemble_parsed_arguments(
    command: Literal["serve", "local"],
    parsed: tuple[Any, ...],
    selected_specs: Sequence[BackendSpec],
    preselection: BackendPreselection,
) -> ParsedArguments:
    by_type: dict[type, Any] = {type(obj): obj for obj in parsed}
    logger.debug("Parsed %d argument classes: %s", len(by_type), [t.__name__ for t in by_type])

    module_kwargs = by_type[ModuleArguments]
    module_kwargs.stt = preselection.stt_name
    module_kwargs.llm_backend = preselection.llm_name
    module_kwargs.tts = preselection.tts_name

    return ParsedArguments(
        module_kwargs=module_kwargs,
        realtime_server_kwargs=_server_args_from_parsed(command, by_type),
        local_audio_kwargs=by_type.get(LocalAudioArguments, LocalAudioArguments()),
        vad_handler_kwargs=by_type[VADHandlerArguments],
        stt_backend=BackendSelection(
            selected_specs[0], selected_specs[0].normalize(by_type[selected_specs[0].config_type])
        ),
        llm_backend=BackendSelection(
            selected_specs[1], selected_specs[1].normalize(by_type[selected_specs[1].config_type])
        ),
        tts_backend=BackendSelection(
            selected_specs[2], selected_specs[2].normalize(by_type[selected_specs[2].config_type])
        ),
    )


def parse_arguments(
    argv: Sequence[str] | None = None,
    *,
    command: Literal["serve", "local"] = "serve",
) -> ParsedArguments:
    module_defaults = ModuleArguments()
    assert module_defaults.stt is not None
    assert module_defaults.llm_backend is not None
    assert module_defaults.tts is not None

    pipeline_args = list(sys.argv[1:] if argv is None else argv)
    preselection = _resolve_backend_names(
        pipeline_args,
        module_defaults,
        command,
    )

    selected_specs = _select_backend_specs(preselection)

    logger.debug(
        "Backend pre-parse: stt=%s, llm=%s, tts=%s",
        preselection.stt_name,
        preselection.llm_name,
        preselection.tts_name,
    )

    parser = _build_argument_parser(command, selected_specs, preselection)
    parsed = _parse_pipeline_dataclasses(parser, pipeline_args, selected_specs, preselection)
    return _assemble_parsed_arguments(
        command,
        parsed,
        selected_specs,
        preselection,
    )


def setup_logger(log_level: str) -> None:
    global logger
    from speech_to_speech.pipeline.log_context import PipelineLogFilter

    logging.basicConfig(
        level=log_level.upper(),
        format="%(asctime)s - %(pipeline_prefix)s%(name)s - %(levelname)s - %(message)s",
    )
    # Attach the filter to every existing handler so each LogRecord gets a
    # `pipeline_prefix` attribute (matching the format string above).
    pipeline_filter = PipelineLogFilter()
    for h in logging.getLogger().handlers:
        h.addFilter(pipeline_filter)

    logger = logging.getLogger(__name__)

    # Silence noisy third-party loggers (httpx logs every HTTP request at INFO).
    # In debug mode we keep them so request/response bodies stay inspectable.
    if log_level != "debug":
        for _noisy in ("httpx", "httpcore", "openai", "huggingface_hub"):
            logging.getLogger(_noisy).setLevel(logging.WARNING)

    # torch compile logs
    if log_level == "debug":
        torch._logging.set_logs(graph_breaks=True, recompiles=True, cudagraphs=True)


def check_mac_settings(module_kwargs: ModuleArguments) -> None:
    if platform == "darwin":
        if module_kwargs.device == "cuda":
            raise ValueError("Cannot use CUDA on macOS. Please set the device to 'cpu' or 'mps'.")
        if module_kwargs.llm_backend != "mlx-lm":
            logger.warning(
                "For macOS users, it is recommended to use mlx-lm. You can activate it by passing --llm_backend mlx-lm."
            )
        if module_kwargs.tts not in ("pocket", "kokoro", "omnivoice", "qwen3"):
            logger.warning(
                "For macOS users, it is recommended to use qwen3 for TTS "
                "(pocket, kokoro, and omnivoice are also valid options)."
            )


def prepare_module_args(module_kwargs: ModuleArguments, llm_backend: BackendSelection) -> None:
    if module_kwargs.tts is None:
        module_kwargs.tts = "qwen3"
    if module_kwargs.stt == "none" and not llm_backend.spec.capabilities.supports_audio_input:
        supported = ", ".join(name for name, spec in LLM_BACKENDS.items() if spec.capabilities.supports_audio_input)
        raise ValueError(f"--stt none requires an audio-input LLM backend; choose one of: {supported}.")
    if module_kwargs.enable_llm_proxy and not llm_backend.spec.capabilities.supports_llm_proxy:
        supported = ", ".join(name for name, spec in LLM_BACKENDS.items() if spec.capabilities.supports_llm_proxy)
        raise ValueError(
            f"The LLM proxy requires a backend with proxy support; choose one of: {supported}. "
            f"Got {llm_backend.name!r}."
        )
    if platform == "darwin":
        check_mac_settings(module_kwargs)


def prepare_all_args(args: ParsedArguments) -> None:
    """Validate selectors and apply the global device to selected configs only."""

    prepare_module_args(args.module_kwargs, args.llm_backend)
    if args.module_kwargs.device is None:
        return
    for field_name in ("stt_backend", "llm_backend", "tts_backend"):
        selection = getattr(args, field_name)
        if "device" not in selection.config:
            continue
        config = {**selection.config, "device": args.module_kwargs.device}
        setattr(args, field_name, replace(selection, config=config))


def build_pipeline(
    args: ParsedArguments,
    stop_event: Event,
    *,
    host: str | None = None,
) -> ThreadManager:
    """Build a pool of pipeline units behind one server."""
    from speech_to_speech.api.openai_realtime.server import RealtimeServer

    module_kwargs = args.module_kwargs
    graph = PipelineGraph(
        module_kwargs=module_kwargs,
        vad_handler_kwargs=args.vad_handler_kwargs,
        stt_backend=args.stt_backend,
        llm_backend=args.llm_backend,
        tts_backend=args.tts_backend,
    )
    pool = [
        graph.instantiate(index=index, stop_event=stop_event)
        for index in range(module_kwargs.num_pipelines)
    ]

    server = RealtimeServer(
        stop_event=stop_event,
        pool=pool,
        host=host or args.realtime_server_kwargs.host,
        port=args.realtime_server_kwargs.port,
        llm_proxy_config=(
            build_llm_proxy_config(module_kwargs, args.llm_backend) if module_kwargs.enable_llm_proxy else None
        ),
        audio_api_config=AudioApiConfig(
            enabled=module_kwargs.enable_audio_api,
            device=module_kwargs.device,
        ),
    )

    handlers: list[Any] = []
    for unit in pool:
        handlers.extend(unit.handlers)
    handlers.append(server)
    return ThreadManager(handlers)


def _emit_security_state(locked: bool) -> None:
    """Print the wake-word security gate state as an EVENT line for the parent."""
    event_type = "security.locked" if locked else "security.unlocked"
    print(f"EVENT: {json.dumps({'type': event_type})}", flush=True)


def build_local_pipeline(args: ParsedArguments, stop_event: Event) -> ThreadManager:
    """Compose the canonical server and audio client over a forced loopback URL."""

    from speech_to_speech.api.openai_realtime.audio_client import (
        RealtimeAudioClient,
        RealtimeAudioClientConfig,
        load_realtime_tool_module,
        load_realtime_tool_modules,
    )

    local_audio = args.local_audio_kwargs
    playback_buffer_ms = local_audio.local_audio_playback_buffer_ms
    if playback_buffer_ms is None:
        playback_buffer_ms = OPENAI_TTS_PLAYBACK_BUFFER_MS if args.tts_backend.name == "openai" else 0.0
    tools: list[dict[str, Any]] = []
    tool_executor = None
    tool_response_create = True
    if local_audio.local_audio_tool_module:
        module_names = [name.strip() for name in local_audio.local_audio_tool_module.split(",")]
        if len(module_names) == 1:
            tools, tool_executor, tool_response_create = load_realtime_tool_module(module_names[0])
        else:
            tools, tool_executor, tool_response_create = load_realtime_tool_modules(module_names)
    server_manager = build_pipeline(args, stop_event, host="127.0.0.1")

    from speech_to_speech.memory import build_memory_provider

    # Memory stays locked until the wake-word gate opens; the gate is the only
    # permission source, so the provider is built locked even when the backend is
    # explicitly enabled.
    memory_provider = build_memory_provider(
        backend=local_audio.local_audio_memory_backend,
        sidecar_python=local_audio.local_audio_memory_sidecar_python,
        sidecar_script=local_audio.local_audio_memory_sidecar_script,
        memory_root=local_audio.local_audio_memory_root,
        max_context_chars=local_audio.local_audio_memory_max_chars,
    )

    # Surface the wake-word security gate's locked/unlocked state to stdout as
    # EVENT lines so the desktop app can mirror it (sleep the orb while locked,
    # wake it on unlock), and mirror it into the memory provider. The gate lives
    # inside the server pipeline; emitting JSONL keeps the parent process from
    # reaching into the handler chain.
    gate = next(
        (
            handler
            for handler in server_manager.handlers
            if callable(getattr(handler, "set_state_change_callback", None))
        ),
        None,
    )
    if gate is not None:

        def _on_security_state(locked: bool) -> None:
            if memory_provider is not None:
                memory_provider.set_unlocked(not locked)
            if local_audio.local_audio_print_json:
                _emit_security_state(locked)

        gate.set_state_change_callback(_on_security_state)
        initial_locked = getattr(gate, "is_locked", None)
        if initial_locked is not None:
            _on_security_state(bool(initial_locked))
    elif memory_provider is not None:
        # No wake-word gate: the explicit CLI opt-in is the permission.
        memory_provider.set_unlocked(True)
    client = RealtimeAudioClient(
        stop_event,
        RealtimeAudioClientConfig(
            url=f"ws://127.0.0.1:{args.realtime_server_kwargs.port}/v1/realtime",
            api_key="local",
            chunk_size=local_audio.local_audio_chunk_size,
            playback_buffer_ms=playback_buffer_ms,
            input_device=local_audio.local_audio_input_device,
            output_device=local_audio.local_audio_output_device,
            print_json=local_audio.local_audio_print_json,
            block_mic_during_playback=local_audio.local_audio_block_mic_during_playback,
            tools=tools,
            tool_executor=tool_executor,
            tool_response_create=tool_response_create,
            memory_provider=memory_provider,
        ),
    )
    handlers: list[Any] = [*server_manager.handlers, client]
    # Exact-text TTS entry for the desktop app (task announcements). It reuses
    # the already-loaded Qwen3-TTS model instead of spawning a second model in
    # a separate process (which contended with the pipeline on MPS). Only
    # enabled when stdin is a pipe (desktop-spawned), so an interactive
    # ``speech-to-speech local`` terminal run is unaffected.
    tts_handler = next(
        (handler for handler in server_manager.handlers if callable(getattr(handler, "synthesize", None))),
        None,
    )
    if tts_handler is not None and sys.stdin is not None and not sys.stdin.isatty():
        from speech_to_speech.local_speaker import LocalSpeakServer

        handlers.append(LocalSpeakServer(stop_event, tts_handler))
    return ThreadManager(handlers)


def _configure_startup(args: ParsedArguments) -> None:
    setup_logger(args.module_kwargs.log_level)
    # Set the transcript gate and warn before any conversation is processed, so an operator
    # sees the notice ahead of the first turn rather than after content is already logged.
    set_log_transcripts(args.module_kwargs.log_transcripts)
    warn_if_log_transcripts_enabled()


def _validate_pipeline_count(args: ParsedArguments) -> None:
    if args.module_kwargs.num_pipelines < 1:
        raise ValueError(f"--num_pipelines must be >= 1, got {args.module_kwargs.num_pipelines}")


def _apply_runtime_adjustments(args: ParsedArguments) -> None:
    prepare_all_args(args)
    # On Apple Silicon, all MLX inference serializes through a global lock (utils/mlx_lock.py).
    # The progressive STT path uses a short timeout and drops work under contention, producing
    # a flood of warnings without affecting final transcripts. With a pool, pre-emptively turn
    # it off so logs stay readable; the final STT path is unaffected. Non-darwin platforms
    # don't share this lock, so leave their live transcription alone.
    if args.module_kwargs.num_pipelines > 1 and platform == "darwin" and args.module_kwargs.enable_live_transcription:
        logger.info(
            "MLX contention: --num_pipelines=%d > 1 on Apple Silicon → disabling live transcription "
            "(progressive STT contends on the global MLX lock)",
            args.module_kwargs.num_pipelines,
        )
        args.module_kwargs.enable_live_transcription = False



def _build_command_manager(
    command: Literal["serve", "local"],
    args: ParsedArguments,
    stop_event: Event,
) -> ThreadManager:
    return build_local_pipeline(args, stop_event) if command == "local" else build_pipeline(args, stop_event)


def _install_shutdown_handlers(pipeline_manager: ThreadManager) -> list[bool]:
    shutdown_requested = [False]

    def signal_handler(_sig: int, _frame: Optional[FrameType]) -> None:
        if not shutdown_requested[0]:
            shutdown_requested[0] = True
            console.print("\n[yellow]Shutting down gracefully...[/yellow]")
            pipeline_manager.stop()
            console.print("[green]✓ Pipeline stopped successfully[/green]")

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    return shutdown_requested


def _run_manager_until_stopped(pipeline_manager: ThreadManager, shutdown_requested: list[bool]) -> None:
    try:
        pipeline_manager.start()
        pipeline_manager.wait()
    except KeyboardInterrupt:
        if not shutdown_requested[0]:
            console.print("\n[yellow]Shutting down gracefully...[/yellow]")
            pipeline_manager.stop()
            console.print("[green]✓ Pipeline stopped successfully[/green]")


def run_pipeline_command(command: Literal["serve", "local"], argv: Sequence[str]) -> None:
    """Run the server alone or compose it with the loopback audio client."""

    args = parse_arguments(argv, command=command)
    _configure_startup(args)
    _validate_pipeline_count(args)
    _apply_runtime_adjustments(args)

    stop_event = Event()
    pipeline_manager = _build_command_manager(command, args, stop_event)
    shutdown_requested = _install_shutdown_handlers(pipeline_manager)
    _run_manager_until_stopped(pipeline_manager, shutdown_requested)


def main() -> None:
    """Compatibility entry point for direct module execution."""

    from speech_to_speech.cli import main as cli_main

    cli_main()


if __name__ == "__main__":
    main()
