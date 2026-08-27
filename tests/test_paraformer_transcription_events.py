import sys
from unittest.mock import MagicMock

import numpy as np
import pytest

from speech_to_speech.pipeline.messages import PartialTranscription, Transcription, VADAudio
from speech_to_speech.STT import paraformer_handler
from speech_to_speech.STT.paraformer_handler import ParaformerSTTHandler
from speech_to_speech.utils.model_registry import SharedModel


class _FakeParaformerModel:
    def generate(self, audio):
        return [{"text": " 今 天 天 气 不 错 "}]


class _FakeMisheardModel:
    """Simulates SEACO output mishearing 脐腐病 as 皮酒病 (per-char spaced)."""

    def generate(self, audio):
        return [{"text": "番茄 皮 酒 病 补 钙 "}]


def _handler(*, language: str = "zh", device: str = "cpu"):
    handler = object.__new__(ParaformerSTTHandler)
    handler.gen_kwargs = {}
    handler._shared = SharedModel(lambda: _FakeParaformerModel())
    handler.language = language
    handler.device = device
    return handler


@pytest.mark.parametrize(
    ("model_name", "expected"),
    [
        ("paraformer-zh", "zh"),
        ("paraformer-en", "en"),
        ("funasr/paraformer-en", "en"),
        ("paraformer-zh-streaming", "zh"),
        ("paraformer", "zh"),
    ],
)
def test_setup_extracts_language_from_model_name(monkeypatch, model_name, expected):
    fake_model = MagicMock()
    fake_model.generate.return_value = [{"text": "warmup"}]
    fake_funasr = MagicMock()
    fake_funasr.AutoModel = MagicMock(return_value=fake_model)
    monkeypatch.setitem(sys.modules, "funasr", fake_funasr)
    monkeypatch.setattr(paraformer_handler.torch.mps, "empty_cache", lambda: None)

    handler = object.__new__(ParaformerSTTHandler)
    handler.setup(model_name=model_name, device="cpu")

    assert handler.language == expected


def test_progressive_paraformer_transcription_is_partial(monkeypatch):
    monkeypatch.setattr(paraformer_handler.console, "print", lambda *args, **kwargs: None)
    monkeypatch.setattr(paraformer_handler.torch.mps, "empty_cache", lambda: None)

    result = list(
        _handler().process(
            VADAudio(
                audio=np.zeros(16000, dtype=np.float32),
                mode="progressive",
                turn_id="turn_1",
                turn_revision=2,
            )
        )
    )

    assert len(result) == 1
    assert isinstance(result[0], PartialTranscription)
    assert result[0].text == "今天天气不错"
    assert result[0].turn_id == "turn_1"
    assert result[0].turn_revision == 2
    assert not hasattr(result[0], "language_code")


def test_final_paraformer_transcription_is_final(monkeypatch):
    monkeypatch.setattr(paraformer_handler.console, "print", lambda *args, **kwargs: None)
    monkeypatch.setattr(paraformer_handler.torch.mps, "empty_cache", lambda: None)

    result = list(
        _handler().process(
            VADAudio(
                audio=np.zeros(16000, dtype=np.float32),
                mode="final",
                turn_id="turn_1",
                turn_revision=2,
                created_at_s=123.0,
            )
        )
    )

    assert len(result) == 1
    assert isinstance(result[0], Transcription)
    assert result[0].text == "今天天气不错"
    assert result[0].language_code == "zh"
    assert result[0].turn_id == "turn_1"
    assert result[0].turn_revision == 2
    assert result[0].speech_stopped_at_s == 123.0


def test_final_paraformer_transcription_uses_english_checkpoint_language(monkeypatch):
    monkeypatch.setattr(paraformer_handler.console, "print", lambda *args, **kwargs: None)
    monkeypatch.setattr(paraformer_handler.torch.mps, "empty_cache", lambda: None)

    result = list(
        _handler(language="en").process(
            VADAudio(
                audio=np.zeros(16000, dtype=np.float32),
                mode="final",
            )
        )
    )

    assert result[0].language_code == "en"


def test_paraformer_skips_mps_cache_clear_on_cpu(monkeypatch):
    monkeypatch.setattr(paraformer_handler.console, "print", lambda *args, **kwargs: None)

    def fail_if_called():
        raise AssertionError("torch.mps.empty_cache should not run on cpu")

    monkeypatch.setattr(paraformer_handler.torch.mps, "empty_cache", fail_if_called)

    result = list(
        _handler(device="cpu").process(
            VADAudio(
                audio=np.zeros(16000, dtype=np.float32),
                mode="final",
            )
        )
    )

    assert len(result) == 1
    assert isinstance(result[0], Transcription)


def test_paraformer_applies_text_level_hotword_correction(monkeypatch):
    """Text-level postprocess_hotwords replace the misheard term in the output."""
    monkeypatch.setattr(paraformer_handler.console, "print", lambda *args, **kwargs: None)
    monkeypatch.setattr(paraformer_handler.torch.mps, "empty_cache", lambda: None)

    handler = _handler()
    handler._shared = SharedModel(lambda: _FakeMisheardModel())
    # Normalized per-character spacing, matching SEACO output (as
    # _prepare_hotwords would build it from {"皮酒病": "脐腐病"}).
    handler._postprocess_hotwords = {"皮 酒 病": "脐 腐 病"}

    result = list(
        handler.process(
            VADAudio(
                audio=np.zeros(16000, dtype=np.float32),
                mode="final",
                turn_id="turn_1",
                turn_revision=2,
                created_at_s=123.0,
            )
        )
    )

    assert result[0].text == "番茄脐腐病补钙"
    assert result[0].language_code == "zh"


def test_paraformer_text_level_hotword_leaves_unknown_text_unchanged(monkeypatch):
    monkeypatch.setattr(paraformer_handler.console, "print", lambda *args, **kwargs: None)
    monkeypatch.setattr(paraformer_handler.torch.mps, "empty_cache", lambda: None)

    handler = _handler()
    handler._postprocess_hotwords = {"皮 酒 病": "脐 腐 病"}

    result = list(
        handler.process(
            VADAudio(
                audio=np.zeros(16000, dtype=np.float32),
                mode="final",
            )
        )
    )

    # Default fake model output "今天天气不错" contains no hotword match.
    assert result[0].text == "今天天气不错"
