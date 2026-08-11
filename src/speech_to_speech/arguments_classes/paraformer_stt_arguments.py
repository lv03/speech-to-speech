from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ParaformerSTTHandlerArguments:
    paraformer_stt_model_name: str = field(
        default="paraformer-zh",
        metadata={
            "help": "The pretrained model to use. Default is 'paraformer-zh'. Can be choose from https://github.com/modelscope/FunASR"
        },
    )
    paraformer_stt_device: str = field(
        default="cuda",
        metadata={"help": "The device type on which the model will run. Default is 'cuda' for GPU acceleration."},
    )
    paraformer_stt_gen_hotword: Optional[str] = field(
        default=None,
        metadata={
            "help": "Model-level hotwords (space-separated) to boost recognition of domain terms, e.g. '""脐腐病 番茄 补钙""'."
        },
    )
    paraformer_stt_gen_postprocess_hotwords: Optional[str] = field(
        default=None,
        metadata={
            "help": "Text-level hotword correction as a JSON object {wrong: target}, e.g. '""{'皮酒病': '脐腐病'}""'. "
            "Space normalization for the SEACO output format is handled internally."
        },
    )
    paraformer_stt_gen_hotword_file: Optional[str] = field(
        default=None,
        metadata={
            "help": "Path to a hotword file for model-level boosting. One term per line; "
            "'#' lines are comments. Terms are joined with spaces automatically."
        },
    )
    paraformer_stt_gen_postprocess_hotword_file: Optional[str] = field(
        default=None,
        metadata={
            "help": "Path to a text-level hotword correction file. Each line is a bare target term "
            "(fuzzy) or an explicit mapping like '错词=>目标词'; '#' lines are comments."
        },
    )
