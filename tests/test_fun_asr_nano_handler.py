import numpy as np
import torch

from speech_to_speech.pipeline.messages import PartialTranscription, Transcription, VADAudio
from speech_to_speech.STT import fun_asr_nano_handler
from speech_to_speech.STT.fun_asr_nano_handler import FunASRNanoSTTHandler
from speech_to_speech.utils.model_registry import SharedModel


class _FakeNanoModel:
    def __init__(self):
        self.calls = []

    def generate(self, audio, **kwargs):
        self.calls.append((audio, kwargs))
        return [{"text": " 开放时间早上九点 "}]


def _handler():
    handler = object.__new__(FunASRNanoSTTHandler)
    fake = _FakeNanoModel()
    handler.model = fake
    handler.device = "cpu"
    handler.gen_kwargs = {}
    handler._shared = SharedModel(lambda: fake)
    return handler


def test_hotwords_are_converted_to_a_list():
    handler = object.__new__(FunASRNanoSTTHandler)
    handler.gen_kwargs = {"hotword": "开放时间 脐腐病  番茄", "hotword_file": None, "language": "中文"}

    handler._prepare_hotwords()

    assert handler.gen_kwargs == {"language": "中文", "hotwords": ["开放时间", "脐腐病", "番茄"]}


def test_progressive_transcription_is_partial(monkeypatch):
    monkeypatch.setattr(fun_asr_nano_handler.console, "print", lambda *args, **kwargs: None)

    handler = _handler()
    result = list(
        handler.process(
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
    assert result[0].text == "开放时间早上九点"
    assert result[0].turn_id == "turn_1"
    assert result[0].turn_revision == 2
    # The handler must convert numpy audio to a torch.Tensor before generate().
    audio, kwargs = handler.model.calls[0]
    assert isinstance(audio, torch.Tensor)
    assert kwargs["cache"] == {}
    assert kwargs["batch_size"] == 1


def test_final_transcription_is_final(monkeypatch):
    monkeypatch.setattr(fun_asr_nano_handler.console, "print", lambda *args, **kwargs: None)

    handler = _handler()
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

    assert len(result) == 1
    assert isinstance(result[0], Transcription)
    assert result[0].text == "开放时间早上九点"
    assert result[0].turn_id == "turn_1"
    assert result[0].turn_revision == 2
    assert result[0].speech_stopped_at_s == 123.0
