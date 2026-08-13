import io
import wave

import numpy as np
from fastapi import FastAPI
from starlette.testclient import TestClient

import speech_to_speech.api.audio_api as audio_api
from speech_to_speech.api.audio_api import AudioApiConfig, mount_audio_api
from speech_to_speech.pipeline.messages import Transcription


def _make_wav_bytes(seconds: float = 0.5, sr: int = 16000) -> bytes:
    buf = io.BytesIO()
    samples = (np.sin(2 * np.pi * 440 * np.arange(int(seconds * sr)) / sr) * 0.2 * 32767).astype(np.int16)
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(samples.tobytes())
    return buf.getvalue()


class _FakeSTTHandler:
    def __init__(self) -> None:
        self.gen_kwargs: dict = {}

    def process(self, vad_audio):
        assert vad_audio.mode == "final"
        yield Transcription(text="你好世界", turn_id=None, turn_revision=None, speech_stopped_at_s=None)


class _FakeTTSHandler:
    def __init__(self) -> None:
        self.speaker = "Aiden"

    def process(self, tts_input):
        yield (np.ones(1600, dtype=np.int16) * 1000)


class _FakeWorker:
    def __init__(self, handler) -> None:
        self.handler = handler

    def run(self, fn):
        return fn(self.handler)


def _client(enabled: bool = True) -> TestClient:
    app = FastAPI()
    mount_audio_api(app, AudioApiConfig(enabled=enabled, device="cpu"))
    return TestClient(app)


def _fake_workers(monkeypatch):
    stt = _FakeSTTHandler()
    tts = _FakeTTSHandler()

    def fake_get_worker(kind, name, device, builder):
        return _FakeWorker(stt if kind == "stt" else tts)

    monkeypatch.setattr(audio_api, "_get_worker", fake_get_worker)
    return stt, tts


def test_disabled_endpoints_return_501():
    client = _client(enabled=False)
    assert client.post("/v1/audio/transcriptions").status_code == 501
    assert client.post("/v1/audio/speech").status_code == 501


def test_transcriptions_rejects_unsupported_model(monkeypatch):
    _fake_workers(monkeypatch)
    client = _client()
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("a.wav", _make_wav_bytes(), "audio/wav")},
        data={"model": "whisper"},
    )
    assert response.status_code == 400
    assert "whisper" in response.json()["error"]["message"]


def test_transcriptions_returns_text(monkeypatch):
    stt, _ = _fake_workers(monkeypatch)
    client = _client()
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("a.wav", _make_wav_bytes(), "audio/wav")},
        data={"model": "paraformer", "hotwords": "开放时间 脐腐病"},
    )
    assert response.status_code == 200
    assert response.json() == {"text": "你好世界"}
    assert stt.gen_kwargs.get("hotword") == "开放时间 脐腐病"


def test_transcriptions_sets_nano_hotwords_as_list(monkeypatch):
    stt, _ = _fake_workers(monkeypatch)
    client = _client()
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("a.wav", _make_wav_bytes(), "audio/wav")},
        data={"model": "fun-asr-nano", "hotwords": "开放时间 脐腐病", "language": "中文"},
    )
    assert response.status_code == 200
    assert stt.gen_kwargs.get("hotwords") == ["开放时间", "脐腐病"]
    assert stt.gen_kwargs.get("language") == "中文"


def test_speech_returns_wav(monkeypatch):
    _, tts = _fake_workers(monkeypatch)
    client = _client()
    response = client.post(
        "/v1/audio/speech",
        json={"model": "qwen3", "input": "你好", "voice": "Bella"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(response.content), "rb") as w:
        assert w.getframerate() == 16000
        assert w.getnchannels() == 1
        assert w.getnframes() > 0
    assert tts.speaker == "Bella"


def test_speech_rejects_unknown_model(monkeypatch):
    _fake_workers(monkeypatch)
    client = _client()
    response = client.post("/v1/audio/speech", json={"model": "chattts", "input": "hi"})
    assert response.status_code == 400


def test_decode_audio_returns_16k_mono_float32():
    audio = audio_api._decode_audio(_make_wav_bytes())
    assert audio.dtype == np.float32
    assert audio.ndim == 1
    assert audio.size > 0


def test_to_wav_roundtrip():
    chunks = [np.ones(800, dtype=np.int16) * 123, np.ones(800, dtype=np.int16) * -456]
    wav_bytes = audio_api._to_wav(chunks)
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        assert w.getframerate() == 16000
        assert w.getnchannels() == 1
        assert w.getnframes() == 1600
