from __future__ import annotations

import contextlib
import io
import logging
from typing import Any, Iterator

import numpy as np
import torch
from rich.console import Console

from speech_to_speech.pipeline.handler_types import STTIn, STTOut
from speech_to_speech.pipeline.messages import PartialTranscription, Transcription
from speech_to_speech.STT.base_stt_handler import BaseSTTHandler
from speech_to_speech.utils.model_registry import canonical_device, get_shared_model

logger = logging.getLogger(__name__)

console = Console()


def _load_fun_asr_model(auto_model_cls: Any, model_name: str, device: str, hub: str) -> Any:
    """Load the FunASR model while silencing its per-key checkpoint warnings.

    Fun-ASR-Nano ships without CTC-decoder weights, so funasr prints a
    ``Warning, miss key in ckpt: ...`` line (via ``print``, not ``logging``)
    for each of the ~86 missing tensors during load. Capture that stdout noise
    and drop it; the load itself still succeeds and the useful
    ``Loading ckpt ... All keys matched`` log line still goes through logging.
    """
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        return auto_model_cls(
            model=model_name,
            device=device,
            hub=hub,
            disable_update=True,
            disable_pbar=True,
        )


class FunASRNanoSTTHandler(BaseSTTHandler):
    """Speech-to-text using FunAudioLLM/Fun-ASR-Nano (LLM-based ASR).

    Fun-ASR-Nano is a ~0.8B end-to-end ASR large model (SenseVoice encoder +
    Qwen3-0.6B decoder). It targets zh/en/ja plus Chinese dialects/accents and
    is FunASR's flagship for real-time speech recognition. It requires a GPU in
    practice (the PyTorch path runs ~3.6x realtime on CPU), and the installed
    ``funasr`` must be recent enough to register the ``FunASRNano`` model class
    (>= 1.4.0).
    """

    def setup(
        self,
        model_name: str = "FunAudioLLM/Fun-ASR-Nano-2512",
        device: str = "cuda",
        hub: str = "hf",
        gen_kwargs: dict[str, Any] = {},
    ) -> None:
        logger.info("Loading Fun-ASR-Nano STT model: %s (hub=%s, device=%s)", model_name, hub, device)
        self.device = device
        self.gen_kwargs = dict(gen_kwargs)
        self._prepare_hotwords()
        try:
            from funasr import AutoModel
        except ModuleNotFoundError as exc:
            raise ModuleNotFoundError(
                "Fun-ASR-Nano STT requires the optional 'paraformer' extra. "
                "Install it with `pip install speech-to-speech[paraformer]`."
            ) from exc
        self._shared = get_shared_model(
            ("stt", "fun-asr-nano", model_name, canonical_device(device)),
            lambda: _load_fun_asr_model(AutoModel, model_name, device, hub),
        )
        self.model = self._shared.load()
        self.warmup()

    def _prepare_hotwords(self) -> None:
        """Convert the space-separated ``hotword``/``hotword_file`` inputs into
        the ``hotwords`` list that Fun-ASR-Nano's prompt builder expects."""
        hotword_file = self.gen_kwargs.pop("hotword_file", None)
        terms: list[str] = []
        if hotword_file:
            terms.extend(self._read_hotword_terms(hotword_file))
        inline = self.gen_kwargs.pop("hotword", None)
        if inline:
            terms = [*[term.strip() for term in str(inline).split(" ") if term.strip()], *terms]

        seen: set[str] = set()
        unique: list[str] = []
        for term in terms:
            term = term.strip()
            if term and term not in seen:
                seen.add(term)
                unique.append(term)
        if unique:
            self.gen_kwargs["hotwords"] = unique
            logger.info("Fun-ASR-Nano hotwords: %s", unique)

    @staticmethod
    def _read_hotword_terms(path: str) -> list[str]:
        """Read model-level hotword terms from a file (one per line)."""
        terms: list[str] = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                terms.append(line)
        if not terms:
            logger.warning("No hotwords found in %s", path)
        return terms

    def warmup(self) -> None:
        logger.info("Warming up %s", self.__class__.__name__)

        # One second of silence is enough for the audio frontend to produce
        # frames while staying cheap to decode. Warmup failures are non-fatal:
        # the model is already loaded and inference may still work.
        dummy_input = torch.zeros(16000, dtype=torch.float32)
        try:
            _ = self._shared.run(lambda m: m.generate(dummy_input, cache={}, batch_size=1))[0]["text"]
        except Exception as exc:
            logger.warning("Fun-ASR-Nano warmup failed: %s", exc)

    def process(self, vad_audio: STTIn) -> Iterator[STTOut]:
        logger.debug("infering Fun-ASR-Nano...")

        # FunASR-Nano's chat template only accepts a file path (str) or a
        # torch.Tensor; a numpy array falls through and produces an empty
        # prompt, so convert explicitly.
        audio = np.asarray(vad_audio.audio, dtype=np.float32)
        audio_tensor = torch.from_numpy(audio)

        try:
            result = self._shared.run(
                lambda m: m.generate(
                    audio_tensor,
                    cache={},
                    batch_size=1,
                    **self.gen_kwargs,
                )
            )
            pred_text = str(result[0].get("text", "")).strip()
        except Exception as exc:
            logger.error("Fun-ASR-Nano inference failed: %s", exc)
            pred_text = ""
        if self.device == "mps":
            torch.mps.empty_cache()

        logger.debug("finished Fun-ASR-Nano inference")
        console.print(f"[yellow]USER: {pred_text}")

        if vad_audio.mode == "progressive":
            yield PartialTranscription(
                text=pred_text,
                turn_id=vad_audio.turn_id,
                turn_revision=vad_audio.turn_revision,
            )
        else:
            yield Transcription(
                text=pred_text,
                turn_id=vad_audio.turn_id,
                turn_revision=vad_audio.turn_revision,
                speech_stopped_at_s=vad_audio.created_at_s,
            )
