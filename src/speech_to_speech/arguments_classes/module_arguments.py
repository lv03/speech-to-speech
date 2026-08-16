from dataclasses import dataclass, field
from typing import Optional

from speech_to_speech.backend_registry import LLM_BACKENDS, STT_BACKENDS, TTS_BACKENDS

_AUDIO_INPUT_LLM_BACKENDS = ", ".join(
    name for name, spec in LLM_BACKENDS.items() if spec.capabilities.supports_audio_input
)
_PROXY_LLM_BACKENDS = ", ".join(name for name, spec in LLM_BACKENDS.items() if spec.capabilities.supports_llm_proxy)


@dataclass
class ModuleArguments:
    device: Optional[str] = field(
        default=None,
        metadata={"help": "If specified, overrides the device for all handlers."},
    )
    mac_optimal_settings: bool = field(
        default=False,
        metadata={
            "help": "If specified, provides macOS defaults: Parakeet TDT for STT, MLX LM for the language "
            "model, Qwen3-TTS for TTS, and MPS for supported component devices. Explicit component, model, "
            "global-device, and component-device flags override these defaults. It does not select a command.",
        },
    )
    stt: Optional[str] = field(
        default="parakeet-tdt",
        metadata={
            "choices": tuple(STT_BACKENDS),
            "help": "The STT to use. Use 'none' to send VAD audio directly to an audio-input LLM. "
            f"Audio-input LLM backends: {_AUDIO_INPUT_LLM_BACKENDS}. Select an explicitly audio-capable "
            "model with --model_name. Default is 'parakeet-tdt'.",
        },
    )
    llm_backend: Optional[str] = field(
        default="responses-api",
        metadata={
            "choices": tuple(LLM_BACKENDS),
            "help": "The LLM backend to use. Default is 'responses-api'.",
        },
    )
    tts: Optional[str] = field(
        default="qwen3",
        metadata={
            "choices": tuple(TTS_BACKENDS),
            "help": "The TTS backend to use. Default is 'qwen3'.",
        },
    )
    log_level: str = field(
        default="info",
        metadata={"help": "Provide logging level. Example --log_level debug, default=info."},
    )
    enable_live_transcription: bool = field(
        default=True,
        metadata={
            "help": "Enable live transcription display while user is speaking (works with parakeet-tdt). Default is true."
        },
    )
    live_transcription_update_interval: float = field(
        default=0.5,
        metadata={"help": "Update interval for live transcription in seconds (default: 0.5s = 500ms)"},
    )
    live_transcription_min_silence_ms: int = field(
        default=500,
        metadata={
            "help": "Minimum silence duration (ms) before ending speech when live transcription is enabled (default: 500ms)"
        },
    )
    enable_llm_proxy: bool = field(
        default=False,
        metadata={
            "help": f"Expose a proxy-capable LLM backend ({_PROXY_LLM_BACKENDS}) as an "
            "OpenAI-compatible HTTP endpoint on the realtime server. The server performs no authentication of "
            "its own: enable it only on a trusted network or behind a gateway that owns access control. Off by "
            "default."
        },
    )
    enable_audio_api: bool = field(
        default=False,
        metadata={
            "help": "Expose standalone ASR/TTS endpoints on the realtime server: "
            "POST /v1/audio/transcriptions (paraformer, fun-asr-nano) and POST /v1/audio/speech (qwen3). "
            "Models load lazily on first request and are shared across requests. No authentication: "
            "enable only on a trusted network. Off by default."
        },
    )
    llm_proxy_connect_timeout_s: float = field(
        default=10.0,
        metadata={
            "help": "Connect timeout in seconds for LLM proxy requests to the upstream provider. Reads have no "
            "timeout (generation may take minutes). Default is 10.0."
        },
    )
    num_pipelines: int = field(
        default=1,
        metadata={
            "help": "Number of isolated pipeline instances in the pool. One uvicorn server listens on "
            "--port and routes each incoming client to the next free pipeline (each has its own "
            "VAD/STT/LM/TTS handlers and conversation state). Max concurrent websocket sessions equals "
            "num_pipelines; further connections are rejected. Default is 1."
        },
    )
    enable_wake_word: bool = field(
        default=False,
        metadata={
            "help": "Lock the pipeline behind a wake word: audio is swallowed (and the assistant stays "
            "silent) until the wake word is heard. With --enable_voiceprint the speaker must also match "
            "the enrolled voiceprint. Off by default."
        },
    )
    wake_word: str = field(
        default="噜噜噜噜",
        metadata={
            "help": "The wake word as displayed text. Detection uses pinyin tone variants of this word "
            "(see speech_to_speech.security.wake_word for how variants are registered). Default is '噜噜噜噜'."
        },
    )
    enable_voiceprint: bool = field(
        default=False,
        metadata={
            "help": "Verify the speaker's voiceprint on the wake word before unlocking. Requires "
            "--enable_wake_word and a profile created with `speech-to-speech voiceprint enroll`. Off by default."
        },
    )
    voiceprint_enrollment: Optional[str] = field(
        default=None,
        metadata={
            "help": "Path to the enrolled voiceprint profile (.npz) created by `speech-to-speech voiceprint "
            "enroll`. Defaults to ~/.cache/speech_to_speech/voiceprint/default.npz when --enable_voiceprint "
            "is set without an explicit path."
        },
    )
    voiceprint_threshold: float = field(
        default=0.75,
        metadata={
            "help": "Cosine similarity threshold for voiceprint acceptance, in (0, 1]. Higher is stricter. "
            "Enrollment and verification both use the wake word, so the enrolled speaker scores near 1.0. "
            "Default is 0.75."
        },
    )
    security_timeout_s: float = field(
        default=60.0,
        metadata={
            "help": "Idle seconds after which the security gate re-locks and requires the wake word again. "
            "Measured from the last audible activity. Default is 60.0."
        },
    )
    unlock_acknowledgment: str = field(
        default="（系统：你刚被唤醒。）请用一句简短的话确认你在听，例如：我在，请说。",
        metadata={
            "help": "Prompt injected after the security gate unlocks so the assistant audibly confirms "
            "the speaker may talk. Set to an empty string to stay silent after unlocking. "
            "Default asks for a one-line '我在，请说。' style reply."
        },
    )
