from __future__ import annotations

import json
import logging
import re
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

# SEACO-Paraformer spaces out Chinese characters but keeps non-CJK runs intact.
_CJK_ONLY_RE = re.compile(r"^[\u4e00-\u9fff]+$")


def _space_each(text: str) -> str:
    """Normalize a hotword to the SEACO output spacing.

    SEACO-Paraformer emits per-character spaces for Chinese (e.g.
    ``"皮 酒 病"``), while English/digit runs stay glued (``"kpi"``). The
    text-level hotword postprocessor matches exact substrings, so both sides
    must share the same spacing: pure-CJK terms are split per character;
    anything containing non-CJK characters is returned as-is.
    """
    cleaned = text.replace(" ", "")
    if not _CJK_ONLY_RE.match(cleaned):
        return cleaned
    return " ".join(cleaned)


class ParaformerSTTHandler(BaseSTTHandler):
    """
    Handles the Speech To Text generation using a Paraformer model.
    The default for this model is set to Chinese.
    This model was contributed by @wuhongsheng.
    """

    def setup(
        self,
        model_name: str = "paraformer-zh",
        device: str = "cuda",
        gen_kwargs: dict[str, Any] = {},
    ) -> None:
        logger.info("Loading Paraformer STT model: %s", model_name)
        if len(model_name.split("/")) > 1:
            model_name = model_name.split("/")[-1]
        self.language = model_name.split("-")[1] if "-" in model_name else "zh"
        self.device = device
        self.gen_kwargs = dict(gen_kwargs)
        self._prepare_hotwords()
        try:
            from funasr import AutoModel
        except ModuleNotFoundError as exc:
            raise ModuleNotFoundError(
                "Paraformer STT requires the optional 'paraformer' extra. "
                "Install it with `pip install speech-to-speech[paraformer]`."
            ) from exc
        self._shared = get_shared_model(
            ("stt", "paraformer", model_name, canonical_device(device)),
            lambda: AutoModel(model=model_name, device=device),
        )
        self.model = self._shared.load()
        self.warmup()

    def _prepare_hotwords(self) -> None:
        """Normalize text-level hotword corrections for SEACO output format.

        Supports four inputs (composable):

        - ``hotword`` (str): model-level terms, space-separated.
        - ``hotword_file`` (str): same as above but read from a file (one term
          per line, ``#`` comments).
        - ``postprocess_hotwords`` (JSON str or dict): text-level corrections
          mapping wrong text to target text.
        - ``postprocess_hotword_file`` (str): same as above but read from a
          file. Each line is either a bare target term (fuzzy) or an explicit
          mapping ``错词=>目标词``; ``#`` lines are comments.

        SEACO outputs per-character spaced text, so explicit keys and values
        are re-spaced here; otherwise exact-substring matching can never hit.
        Example: ``{"皮酒病": "脐腐病"}`` becomes ``{"皮 酒 病": "脐 腐 病"}``.
        """
        # Model-level hotword file -> space-joined string.
        hotword_file = self.gen_kwargs.pop("hotword_file", None)
        if hotword_file:
            terms = self._read_hotword_terms(hotword_file)
            if terms:
                existing = str(self.gen_kwargs.get("hotword") or "").strip()
                self.gen_kwargs["hotword"] = " ".join(
                    filter(None, [existing, *terms]),
                )

        # Text-level corrections: file overrides inline JSON when both absent;
        # inline JSON wins if already present. Popped from gen_kwargs so the
        # mapping is applied here (process) instead of being forwarded to
        # funasr's generate(), which ignores it.
        postprocess_file = self.gen_kwargs.pop("postprocess_hotword_file", None)
        raw = self.gen_kwargs.pop("postprocess_hotwords", None)
        if postprocess_file and not raw:
            raw = self._read_postprocess_hotwords(postprocess_file)
        if not raw:
            self._postprocess_hotwords = {}
            return
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning(
                    "Ignoring invalid postprocess_hotwords JSON: %r", raw,
                )
                self._postprocess_hotwords = {}
                return
        if not isinstance(raw, dict):
            logger.warning(
                "Ignoring postprocess_hotwords: expected a JSON object mapping "
                "wrong text to target text, got %r", raw,
            )
            self._postprocess_hotwords = {}
            return
        self._postprocess_hotwords = {
            _space_each(str(wrong)): _space_each(str(right))
            for wrong, right in raw.items()
        }
        logger.info(
            "Paraformer text-level hotwords: %s", self._postprocess_hotwords,
        )

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

    @staticmethod
    def _read_postprocess_hotwords(path: str) -> dict[str, str]:
        """Read text-level hotword corrections from a file.

        Each line is either a bare target term (self-mapping, fuzzy mode) or an
        explicit mapping ``错词=>目标词`` (or ``错词->目标词``). ``#`` lines are
        comments.
        """
        mapping: dict[str, str] = {}
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                for sep in ("=>", "->"):
                    if sep in line:
                        wrong, right = line.split(sep, 1)
                        wrong = wrong.strip()
                        right = right.strip()
                        if wrong and right:
                            mapping[wrong] = right
                        break
                else:
                    mapping[line] = line  # bare term -> fuzzy target
        if not mapping:
            logger.warning("No hotword corrections found in %s", path)
        return mapping

    def warmup(self) -> None:
        logger.info(f"Warming up {self.__class__.__name__}")

        # 2 warmup steps for no compile or compile mode with CUDA graphs capture
        n_steps = 1
        dummy_input = np.array([0] * 512, dtype=np.float32)
        for _ in range(n_steps):
            _ = self._shared.run(lambda m: m.generate(dummy_input))[0]["text"].strip().replace(" ", "")

    def _apply_text_hotwords(self, text: str) -> str:
        """Apply text-level hotword corrections to raw ASR output.

        Runs on the SEACO-spaced text *before* space-stripping: keys/values
        were normalized to per-character spacing in ``_prepare_hotwords`` so
        exact-substring replacement matches the model's ``"皮 酒 病"`` output.
        """
        for wrong, right in getattr(self, "_postprocess_hotwords", {}).items():
            if wrong in text:
                text = text.replace(wrong, right)
        return text

    def process(self, vad_audio: STTIn) -> Iterator[STTOut]:
        logger.debug("infering paraformer...")

        raw_text = self._shared.run(lambda m: m.generate(vad_audio.audio, **self.gen_kwargs))[0]["text"].strip()
        pred_text = self._apply_text_hotwords(raw_text).replace(" ", "")
        # Same idea as ChatTTSHandler: MPS cache clear only on Apple Silicon.
        if self.device == "mps":
            torch.mps.empty_cache()

        logger.debug("finished paraformer inference")
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
                language_code=self.language,
                turn_id=vad_audio.turn_id,
                turn_revision=vad_audio.turn_revision,
                speech_stopped_at_s=vad_audio.created_at_s,
            )
