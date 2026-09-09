from dataclasses import dataclass, field
from typing import Optional


@dataclass
class LocalAudioArguments:
    local_audio_tool_module: Optional[str] = field(
        default=None,
        metadata={
            "help": "Importable module defining TOOLS and async execute_tool(name, arguments).",
            "aliases": ["--tool-module"],
        },
    )
    local_audio_input_device: Optional[int] = field(
        default=None,
        metadata={"help": "Optional sounddevice input device index used by the local command."},
    )
    local_audio_output_device: Optional[int] = field(
        default=None,
        metadata={"help": "Optional sounddevice output device index used by the local command."},
    )
    local_audio_chunk_size: int = field(
        default=1024,
        metadata={"help": "Microphone and speaker callback block size in samples. Default is 1024."},
    )
    local_audio_playback_buffer_ms: Optional[float] = field(
        default=None,
        metadata={
            "help": (
                "Audio to buffer before local playback starts, in milliseconds. "
                "Defaults to 196 for OpenAI-compatible TTS and 0 otherwise."
            ),
            "aliases": ["--playback-buffer-ms"],
        },
    )
    local_audio_block_mic_during_playback: bool = field(
        default=False,
        metadata={
            "help": "Pause local microphone capture while audio is playing. Disabled by default so barge-in works."
        },
    )
    local_audio_memory_backend: Optional[str] = field(
        default=None,
        metadata={
            "help": (
                "Optional long-term memory backend for the local command: off or voicemem. "
                "Unset falls back to S2S_MEMORY_BACKEND, so a parent process can enable it "
                "without argv."
            ),
            "choices": ("off", "voicemem"),
            "aliases": ["--memory-backend"],
        },
    )
    local_audio_memory_sidecar_python: Optional[str] = field(
        default=None,
        metadata={
            "help": "Interpreter that has voicemem installed (its own venv, never this runtime).",
            "aliases": ["--memory-sidecar-python"],
        },
    )
    local_audio_memory_sidecar_script: Optional[str] = field(
        default=None,
        metadata={
            "help": "Path to the memory sidecar JSONL entry point.",
            "aliases": ["--memory-sidecar-script"],
        },
    )
    local_audio_memory_root: Optional[str] = field(
        default=None,
        metadata={
            "help": "App-private directory for the memory store.",
            "aliases": ["--memory-root"],
        },
    )
    local_audio_memory_max_chars: int = field(
        default=1200,
        metadata={
            "help": "Maximum characters of the memory block injected into a response.",
            "aliases": ["--memory-max-chars"],
        },
    )
    local_audio_print_json: bool = field(
        default=False,
        metadata={"help": "Print raw Realtime events received by the packaged local audio client."},
    )
