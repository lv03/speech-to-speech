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
    _is_json = len(pipeline_args) == 1 and pipeline_args[0].endswith(".json")
    pipeline_json: dict[str, Any] | None = None
    if _is_json:
        with open(pipeline_args[0]) as _f:
            pipeline_json = json.load(_f)
        _mac_preset_enabled = bool(pipeline_json.get("mac_optimal_settings", False))
        _llm_name = pipeline_json.get("llm_backend") or (
            "mlx-lm" if _mac_preset_enabled else module_defaults.llm_backend
        )
        if _mac_preset_enabled:
            pipeline_json = {**_mac_preset_defaults(_llm_name), **pipeline_json}
        _stt_name = pipeline_json.get("stt") or module_defaults.stt
        _tts_name = pipeline_json.get("tts") or module_defaults.tts
    else:
        _pre = argparse.ArgumentParser(prog=f"speech-to-speech {command}", add_help=False)
        _pre.add_argument("--mac-optimal-settings", action="store_true")
        _pre.add_argument("--stt", choices=tuple(STT_BACKENDS))
        _pre.add_argument("--llm_backend", "--llm-backend", choices=tuple(LLM_BACKENDS))
        _pre.add_argument("--tts", choices=tuple(TTS_BACKENDS))
        _pre_args = _pre.parse_known_args(pipeline_args)[0]
        _mac_preset_enabled = _pre_args.mac_optimal_settings
        _stt_name = _pre_args.stt or module_defaults.stt
        _llm_name = _pre_args.llm_backend or ("mlx-lm" if _mac_preset_enabled else module_defaults.llm_backend)
        _tts_name = _pre_args.tts or module_defaults.tts

    selected_specs = []
    for registry, name in (
        (STT_BACKENDS, _stt_name),
        (LLM_BACKENDS, _llm_name),
        (TTS_BACKENDS, _tts_name),
    ):
        try:
            selected_specs.append(registry[name])
        except KeyError as exc:
            choices = ", ".join(registry)
            raise ValueError(f"Unsupported backend {name!r}; choose one of: {choices}.") from exc

    logger.debug(
        "Backend pre-parse: stt=%s, llm=%s, tts=%s",
        _stt_name,
        _llm_name,
        _tts_name,
    )

    server_arguments_class = RealtimeServerArguments if command == "serve" else LocalRealtimeServerArguments
    argument_classes: list[type[Any]] = [
        ModuleArguments,
        server_arguments_class,
    ]
    if command == "local":
        argument_classes.append(LocalAudioArguments)
    argument_classes.extend(
        [
            VADHandlerArguments,
            *(spec.config_type for spec in selected_specs),
        ]
    )
    parser = HfArgumentParser(tuple(argument_classes), prog=f"speech-to-speech {command}")  # type: ignore[arg-type]
    mac_action = parser._option_string_actions.pop("--mac_optimal_settings")
    mac_action.option_strings = [option for option in mac_action.option_strings if option != "--mac_optimal_settings"]
    if _mac_preset_enabled:
        parser.set_defaults(**_mac_preset_defaults(_llm_name))

    if _is_json:
        assert pipeline_json is not None
        parsed = parser.parse_dict(pipeline_json, allow_extra_keys=True)
    else:
        parsed = _parse_selected_cli_configs(parser, pipeline_args, selected_specs)

    # Build a {type: instance} lookup so field assignment is order-independent.
    by_type: dict[type, Any] = {type(obj): obj for obj in parsed}
    logger.debug("Parsed %d argument classes: %s", len(by_type), [t.__name__ for t in by_type])
    if command == "serve":
        realtime_server_kwargs = by_type[RealtimeServerArguments]
    else:
        realtime_server_kwargs = RealtimeServerArguments(
            host="127.0.0.1",
            port=by_type[LocalRealtimeServerArguments].port,
        )

    module_kwargs = by_type[ModuleArguments]
    module_kwargs.stt = _stt_name
    module_kwargs.llm_backend = _llm_name
    module_kwargs.tts = _tts_name
    args = ParsedArguments(
        module_kwargs=module_kwargs,
        realtime_server_kwargs=realtime_server_kwargs,
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
    return args


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
        if module_kwargs.tts not in ("pocket", "kokoro", "qwen3"):
            logger.warning(
                "For macOS users, it is recommended to use qwen3 for TTS (pocket and kokoro are also valid options)."
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
    if module_kwargs.enable_voiceprint and not module_kwargs.enable_wake_word:
        raise ValueError("--enable_voiceprint requires --enable_wake_word (the voiceprint is verified on the wake word).")
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


def build_local_pipeline(args: ParsedArguments, stop_event: Event) -> ThreadManager:
    """Compose the canonical server and audio client over a forced loopback URL."""

    from speech_to_speech.api.openai_realtime.audio_client import (
        RealtimeAudioClient,
        RealtimeAudioClientConfig,
        load_realtime_tool_module,
    )

    local_audio = args.local_audio_kwargs
    tools: list[dict[str, Any]] = []
    tool_executor = None
    tool_response_create = True
    if local_audio.local_audio_tool_module:
        tools, tool_executor, tool_response_create = load_realtime_tool_module(local_audio.local_audio_tool_module)
    server_manager = build_pipeline(args, stop_event, host="127.0.0.1")
    client = RealtimeAudioClient(
        stop_event,
        RealtimeAudioClientConfig(
            url=f"ws://127.0.0.1:{args.realtime_server_kwargs.port}/v1/realtime",
            api_key="local",
            chunk_size=local_audio.local_audio_chunk_size,
            input_device=local_audio.local_audio_input_device,
            output_device=local_audio.local_audio_output_device,
            print_json=local_audio.local_audio_print_json,
            block_mic_during_playback=local_audio.local_audio_block_mic_during_playback,
            tools=tools,
            tool_executor=tool_executor,
            tool_response_create=tool_response_create,
        ),
    )
    return ThreadManager([*server_manager.handlers, client])


def run_pipeline_command(command: Literal["serve", "local"], argv: Sequence[str]) -> None:
    """Run the server alone or compose it with the loopback audio client."""

    args = parse_arguments(argv, command=command)

    setup_logger(args.module_kwargs.log_level)

    if args.module_kwargs.num_pipelines < 1:
        raise ValueError(f"--num_pipelines must be >= 1, got {args.module_kwargs.num_pipelines}")

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

    stop_event = Event()
    pipeline_manager = (
        build_local_pipeline(args, stop_event) if command == "local" else build_pipeline(args, stop_event)
    )

    # Set up graceful shutdown handler
    shutdown_requested = [False]  # Use list for nonlocal mutation

    def signal_handler(_sig: int, _frame: Optional[FrameType]) -> None:
        if not shutdown_requested[0]:
            shutdown_requested[0] = True
            console.print("\n[yellow]Shutting down gracefully...[/yellow]")
            pipeline_manager.stop()
            console.print("[green]✓ Pipeline stopped successfully[/green]")

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    try:
        pipeline_manager.start()
        pipeline_manager.wait()
    except KeyboardInterrupt:
        if not shutdown_requested[0]:
            console.print("\n[yellow]Shutting down gracefully...[/yellow]")
            pipeline_manager.stop()
            console.print("[green]✓ Pipeline stopped successfully[/green]")


def main() -> None:
    """Compatibility entry point for direct module execution."""

    from speech_to_speech.cli import main as cli_main

    cli_main()


if __name__ == "__main__":
    main()
