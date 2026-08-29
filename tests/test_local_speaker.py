"""Tests for the packaged local ``speak`` entry (LocalSpeakServer)."""

from io import StringIO
from threading import Event

import numpy as np

from speech_to_speech.local_speaker import LocalSpeakServer, PIPELINE_SAMPLE_RATE


class _FakeTTSHandler:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self.last_text = None

    def synthesize(self, text):
        self.last_text = text
        yield from self._chunks


def test_synthesize_concatenates_int16_chunks():
    handler = _FakeTTSHandler([np.ones(10, dtype=np.int16), np.full(20, 2, dtype=np.int16)])
    server = LocalSpeakServer(Event(), handler, StringIO())

    pcm = server.synthesize("hi")

    assert pcm.dtype == np.int16
    assert pcm.shape == (30,)
    assert pcm[0] == 1
    assert pcm[-1] == 2


def test_handle_shutdown_sets_stop_event():
    stop_event = Event()
    server = LocalSpeakServer(stop_event, _FakeTTSHandler([]), StringIO())

    server._handle_line('{"type": "shutdown"}')

    assert stop_event.is_set()


def test_handle_speak_synthesizes_and_plays(monkeypatch):
    played = {}

    fake_sd = type(
        "FakeSD",
        (),
        {
            "play": staticmethod(lambda pcm, rate: played.update(pcm=pcm, rate=rate)),
            "wait": staticmethod(lambda: None),
        },
    )
    monkeypatch.setitem(__import__("sys").modules, "sounddevice", fake_sd)

    handler = _FakeTTSHandler([np.ones(512, dtype=np.int16)])
    server = LocalSpeakServer(Event(), handler, StringIO())

    server._handle_line('{"type": "speak", "text": "任务已完成"}')

    assert handler.last_text == "任务已完成"
    assert played["rate"] == PIPELINE_SAMPLE_RATE
    assert played["pcm"].dtype == np.int16
    assert played["pcm"].shape == (512,)


def test_handle_ignores_malformed_and_unknown_lines(capsys):
    handler = _FakeTTSHandler([])
    server = LocalSpeakServer(Event(), handler, StringIO())

    server._handle_line("not json")
    server._handle_line('{"type": "unknown"}')
    server._handle_line('{"type": "speak", "text": ""}')

    assert handler.last_text is None
    captured = capsys.readouterr()
    assert captured.out == ""


def test_run_exits_on_eof():
    handler = _FakeTTSHandler([])
    server = LocalSpeakServer(Event(), handler, StringIO(""))

    # StringIO is at EOF immediately; run() should return without hanging.
    server.run()
