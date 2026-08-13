import numpy as np

from speech_to_speech.api.audio_api import _ChunkStreamingTranscriber, _StreamingTranscriber


class _FakeVAD:
    """Minimal VADIterator stand-in: triggers speech on the first window and
    closes the utterance after ``speech_windows`` more windows."""

    def __init__(self, speech_windows: int = 2) -> None:
        self.triggered = False
        self._speech_windows = speech_windows
        self._seen = 0
        self._collected: list = []

    def __call__(self, window):
        self._seen += 1
        if not self.triggered:
            self.triggered = True
            self._collected = [window]
            return None
        self._collected.append(window)
        if self._seen >= self._speech_windows + 1:
            utterance = list(self._collected)
            self._collected = []
            self.triggered = False
            return utterance
        return None


def _chunk(n: int = 512) -> np.ndarray:
    return (np.ones(n, dtype=np.int16) * 1000)


def _transcriber(transcribe, vad=None, partial_interval_s=0.5):
    return _StreamingTranscriber(transcribe, vad or _FakeVAD(), partial_interval_s=partial_interval_s)


def test_streaming_emits_speech_started_and_final():
    def transcribe(_audio):
        return "你好"

    session = _transcriber(transcribe)

    events = []
    for _ in range(3):
        events.extend(session.push(_chunk()))

    types = [e["type"] for e in events]
    assert "speech_started" in types
    assert any(e["type"] == "final" and e["text"] == "你好" for e in events)


def test_streaming_finish_flushes_pending_speech():
    def transcribe(_audio):
        return "未完成"

    session = _transcriber(transcribe)

    session.push(_chunk())  # speech starts, never ends

    events = session.finish()
    assert events == [{"type": "final", "text": "未完成"}]


def test_streaming_emits_partial_during_speech():
    def transcribe(_audio):
        return "partial"

    session = _transcriber(transcribe, vad=_FakeVAD(speech_windows=5), partial_interval_s=0.0)

    session.push(_chunk())  # triggers speech + immediate partial
    events = session.push(_chunk())

    assert any(e["type"] == "partial" and e["text"] == "partial" for e in events)


def test_streaming_buffers_sub_window_chunks():
    def transcribe(_audio):
        return "ok"

    session = _transcriber(transcribe)

    # Feed 100 samples at a time; the transcriber must buffer until a full
    # 512-sample window is available and still reach a final result.
    events = []
    for _ in range(16):
        events.extend(session.push(np.ones(100, dtype=np.int16)))

    assert any(e["type"] == "final" for e in events)


class _FakeOnlineModel:
    """Fake paraformer-zh-online: returns one token per chunk, in order."""

    def __init__(self, tokens=("开", "放", "时")):
        self.tokens = list(tokens)
        self.calls = []

    def generate(self, input, cache=None, is_final=False, chunk_size=None):
        self.calls.append((input, is_final))
        if is_final:
            return [{"text": ""}]
        if not self.tokens:
            return [{"text": ""}]
        return [{"text": self.tokens.pop(0)}]


def _chunk_session(tokens=("开", "放", "时"), stride=9600):
    model = _FakeOnlineModel(tokens)
    session = _ChunkStreamingTranscriber(lambda a, c, f: model.generate(input=a, cache=c, is_final=f), chunk_size=(0, 10, 5))
    session._stride = stride
    return model, session


def test_chunk_streaming_accumulates_incremental_text():
    model, session = _chunk_session(tokens=("开", "放"))

    events = []
    events.extend(session.push(np.ones(9600, dtype=np.int16) * 1000))
    events.extend(session.push(np.ones(9600, dtype=np.int16) * 1000))

    assert [e["text"] for e in events if e["type"] == "partial"] == ["开", "开放"]
    assert session.finish() == [{"type": "final", "text": "开放"}]


def test_chunk_streaming_buffers_partial_stride():
    model, session = _chunk_session(tokens=("开",))

    # Only half a stride: no chunk is processed yet.
    assert session.push(np.ones(4800, dtype=np.int16)) == []
    # Second half completes a stride and emits a partial.
    events = session.push(np.ones(4800, dtype=np.int16))
    assert any(e["type"] == "partial" and e["text"] == "开" for e in events)
    assert session.finish() == [{"type": "final", "text": "开"}]
