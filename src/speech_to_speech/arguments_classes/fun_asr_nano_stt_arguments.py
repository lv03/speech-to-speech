from dataclasses import dataclass, field
from typing import Optional


@dataclass
class FunASRNanoSTTHandlerArguments:
    fun_asr_nano_stt_model_name: str = field(
        default="FunAudioLLM/Fun-ASR-Nano-2512",
        metadata={
            "help": "Fun-ASR-Nano model identifier. Default is the HuggingFace ID "
            "'FunAudioLLM/Fun-ASR-Nano-2512'. For 31-language coverage use "
            "'FunAudioLLM/Fun-ASR-MLT-Nano-2512'."
        },
    )
    fun_asr_nano_stt_device: str = field(
        default="cuda",
        metadata={"help": "Device type on which the model runs: 'cuda', 'mps', or 'cpu'."},
    )
    fun_asr_nano_stt_hub: str = field(
        default="hf",
        metadata={"help": "Model hub to download from: 'hf' (HuggingFace) or 'ms' (ModelScope)."},
    )
    fun_asr_nano_stt_gen_language: Optional[str] = field(
        default=None,
        metadata={
            "help": "Language hint passed to the model, e.g. '中文', 'auto', or 'en'. "
            "Default lets the model decide from the audio."
        },
    )
    fun_asr_nano_stt_gen_hotword: Optional[str] = field(
        default=None,
        metadata={
            "help": "Model-level hotwords (space-separated) to boost recall of domain terms, "
            "e.g. '开放时间 脐腐病'. Converted to a list for the model internally."
        },
    )
    fun_asr_nano_stt_gen_hotword_file: Optional[str] = field(
        default=None,
        metadata={
            "help": "Path to a hotword file for model-level boosting. One term per line; "
            "'#' lines are comments."
        },
    )
