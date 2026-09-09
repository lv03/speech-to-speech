import sys
from threading import Event
from types import SimpleNamespace

from speech_to_speech.api.openai_realtime.audio_client import RealtimeAudioClient
from speech_to_speech.api.openai_realtime.server import RealtimeServer
from speech_to_speech.s2s_pipeline import build_local_pipeline, build_pipeline, parse_arguments


def _default_args():
    original_argv = sys.argv[:]
    try:
        sys.argv = ["speech-to-speech"]
        return parse_arguments()
    finally:
        sys.argv = original_argv


def test_serve_builds_pipeline_unit_pool(monkeypatch):
    args = _default_args()
    args.module_kwargs.num_pipelines = 2
    unit_handlers = [object(), object()]
    units = [SimpleNamespace(handlers=[handler]) for handler in unit_handlers]
    calls = []

    def fake_instantiate(self, **kwargs):
        calls.append(kwargs)
        return units[kwargs["index"]]

    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", fake_instantiate)
    stop_event = Event()
    manager = build_pipeline(args, stop_event)

    assert manager.handlers[:2] == unit_handlers
    assert len(manager.handlers) == 3
    assert isinstance(manager.handlers[-1], RealtimeServer)
    assert manager.handlers[-1].pool == units
    assert manager.handlers[-1].stop_event is stop_event
    assert [call["index"] for call in calls] == [0, 1]


def test_local_composes_loopback_client_with_same_server_builder(monkeypatch):
    args = _default_args()
    args.realtime_server_kwargs.host = "192.0.2.10"
    args.realtime_server_kwargs.port = 9876
    args.local_audio_kwargs.local_audio_playback_buffer_ms = 240
    pipeline_handler = object()
    unit = SimpleNamespace(handlers=[pipeline_handler])
    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", lambda self, **_kwargs: unit)

    manager = build_local_pipeline(args, Event())

    assert manager.handlers[0] is pipeline_handler
    server = manager.handlers[1]
    client = manager.handlers[2]
    assert isinstance(server, RealtimeServer)
    assert isinstance(client, RealtimeAudioClient)
    assert server.pool == [unit]
    assert server.host == "127.0.0.1"
    assert server.port == 9876
    assert client.config.url == f"ws://127.0.0.1:{server.port}/v1/realtime"
    assert client.config.api_key == "local"
    assert client.config.playback_buffer_ms == 240


def test_local_resolves_backend_specific_playback_buffer_defaults(monkeypatch):
    unit = SimpleNamespace(handlers=[object()])
    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", lambda self, **_kwargs: unit)

    cases = [
        (["--tts", "qwen3"], 0),
        (["--tts", "openai"], 196),
        (["--tts", "openai", "--playback-buffer-ms", "0"], 0),
        (["--tts", "openai", "--playback-buffer-ms", "240"], 240),
    ]
    for argv, expected_buffer_ms in cases:
        args = parse_arguments(argv, command="local")
        manager = build_local_pipeline(args, Event())
        client = manager.handlers[-1]

        assert isinstance(client, RealtimeAudioClient)
        assert client.config.playback_buffer_ms == expected_buffer_ms


def test_local_emits_initial_security_state_for_desktop_sync(monkeypatch, capsys):
    class FakeSecurityGate:
        def __init__(self):
            self.is_locked = True
            self.callbacks = []

        def set_state_change_callback(self, callback):
            self.callbacks.append(callback)

    gate = FakeSecurityGate()
    unit = SimpleNamespace(handlers=[gate])
    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", lambda self, **_kwargs: unit)

    args = _default_args()
    args.module_kwargs.enable_wake_word = True
    args.local_audio_kwargs.local_audio_print_json = True

    build_local_pipeline(args, Event())

    assert gate.callbacks, "expected the local pipeline to register a security-state callback"
    assert 'EVENT: {"type": "security.locked"}' in capsys.readouterr().out


def test_local_keeps_memory_off_by_default(monkeypatch):
    unit = SimpleNamespace(handlers=[object()])
    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", lambda self, **_kwargs: unit)

    args = _default_args()
    manager = build_local_pipeline(args, Event())
    client = manager.handlers[-1]

    assert client.config.memory_provider is None


def test_local_builds_a_locked_memory_provider_and_mirrors_the_gate(monkeypatch):
    calls: list[bool] = []

    class FakeProvider:
        enabled = True

        def set_unlocked(self, unlocked):
            calls.append(bool(unlocked))

    provider = FakeProvider()
    monkeypatch.setattr(
        "speech_to_speech.memory.build_memory_provider",
        lambda **_kwargs: provider,
    )

    class FakeGate:
        is_locked = True

        def __init__(self):
            self.callbacks = []

        def set_state_change_callback(self, callback):
            self.callbacks.append(callback)

    gate = FakeGate()
    unit = SimpleNamespace(handlers=[gate])
    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", lambda self, **_kwargs: unit)

    args = parse_arguments(["--memory-backend", "voicemem"], command="local")
    manager = build_local_pipeline(args, Event())
    client = manager.handlers[-1]

    assert client.config.memory_provider is provider
    # Initial locked state is mirrored, then unlocking the gate unlocks memory.
    assert calls == [False]
    gate.callbacks[0](False)
    assert calls == [False, True]
    gate.callbacks[0](True)
    assert calls == [False, True, False]


def test_local_unlocks_memory_when_there_is_no_security_gate(monkeypatch):
    calls: list[bool] = []

    class FakeProvider:
        enabled = True

        def set_unlocked(self, unlocked):
            calls.append(bool(unlocked))

    monkeypatch.setattr(
        "speech_to_speech.memory.build_memory_provider",
        lambda **_kwargs: FakeProvider(),
    )
    unit = SimpleNamespace(handlers=[object()])
    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", lambda self, **_kwargs: unit)

    args = parse_arguments(["--memory-backend", "voicemem"], command="local")
    build_local_pipeline(args, Event())

    assert calls == [True]


def test_local_emits_memory_health_only_for_the_parent(monkeypatch, capsys):
    import json

    class FakeProvider:
        enabled = True
        unlocked = False

        def set_unlocked(self, unlocked):
            self.unlocked = bool(unlocked)

        def health(self):
            return {"ok": True, "backend": "voicemem", "pendingTurns": 2, "warning": ""}

    provider = FakeProvider()
    monkeypatch.setattr("speech_to_speech.memory.build_memory_provider", lambda **_kwargs: provider)
    unit = SimpleNamespace(handlers=[object()])
    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", lambda self, **_kwargs: unit)

    # Without print_json the parent gets no EVENT lines at all.
    quiet = parse_arguments(["--memory-backend", "voicemem"], command="local")
    build_local_pipeline(quiet, Event())
    assert "memory.health" not in capsys.readouterr().out

    loud = parse_arguments(
        ["--memory-backend", "voicemem", "--local_audio_print_json"],
        command="local",
    )
    build_local_pipeline(loud, Event())
    out = capsys.readouterr().out
    events = [json.loads(line[len("EVENT: "):]) for line in out.splitlines() if line.startswith("EVENT: ")]
    health = [event for event in events if event["type"] == "memory.health"]
    assert health and health[-1]["ok"] is True and health[-1]["pendingTurns"] == 2
    assert "voicemem" in health[-1]["backend"]


def test_local_reports_a_bad_memory_configuration_instead_of_crashing(monkeypatch, capsys):
    import json

    def exploding_factory(**_kwargs):
        raise ValueError("memory backend 'voicemem' requires extraction_base_url")

    monkeypatch.setattr("speech_to_speech.memory.build_memory_provider", exploding_factory)
    unit = SimpleNamespace(handlers=[object()])
    monkeypatch.setattr("speech_to_speech.pipeline_graph.PipelineGraph.instantiate", lambda self, **_kwargs: unit)

    args = parse_arguments(
        ["--memory-backend", "voicemem", "--local_audio_print_json"],
        command="local",
    )
    manager = build_local_pipeline(args, Event())
    client = manager.handlers[-1]

    assert client.config.memory_provider is None
    out = capsys.readouterr().out
    events = [json.loads(line[len("EVENT: "):]) for line in out.splitlines() if line.startswith("EVENT: ")]
    degraded = [event for event in events if event["type"] == "memory.health" and event["ok"] is False]
    assert degraded and "extraction_base_url" in degraded[-1]["warning"]
