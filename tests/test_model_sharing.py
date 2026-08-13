import numpy as np

from speech_to_speech.utils.model_registry import canonical_device, get_shared_model, reset_shared_models


def test_get_shared_model_loads_once_and_shares_instance():
    reset_shared_models()
    calls = []

    def loader():
        calls.append(1)
        return {"weights": np.zeros(2)}

    first = get_shared_model("k", loader)
    second = get_shared_model("k", loader)

    assert first is second
    assert first.load() is second.load()
    assert len(calls) == 1


def test_canonical_device_resolves_unavailable_accelerators():
    assert canonical_device(None) == "cpu"
    assert canonical_device("cpu") == "cpu"
    # "cuda" and "mps" fall back to "cpu" when the accelerator is absent;
    # they stay put when present.
    assert canonical_device("cuda") in {"cuda", "cpu"}
    assert canonical_device("mps") in {"mps", "cpu"}


def test_paraformer_handlers_share_model_instance(monkeypatch):
    import funasr

    from speech_to_speech.STT.paraformer_handler import ParaformerSTTHandler

    reset_shared_models()
    instances = []

    class _FakeAutoModel:
        def __init__(self, model=None, device=None):
            self.model = model
            instances.append(self)

        def generate(self, audio, **kwargs):
            return [{"text": "测试"}]

    monkeypatch.setattr(funasr, "AutoModel", _FakeAutoModel)

    handler_a = object.__new__(ParaformerSTTHandler)
    handler_a.setup(model_name="paraformer-zh", device="cpu", gen_kwargs={})
    handler_b = object.__new__(ParaformerSTTHandler)
    handler_b.setup(model_name="paraformer-zh", device="cpu", gen_kwargs={})

    assert handler_a._shared is handler_b._shared
    assert handler_a.model is handler_b.model
    assert len(instances) == 1  # the model was constructed exactly once


def test_paraformer_handlers_with_different_devices_do_not_share(monkeypatch):
    import funasr

    from speech_to_speech.STT.paraformer_handler import ParaformerSTTHandler

    reset_shared_models()
    instances = []

    class _FakeAutoModel:
        def __init__(self, model=None, device=None):
            instances.append(self)

        def generate(self, audio, **kwargs):
            return [{"text": "测试"}]

    monkeypatch.setattr(funasr, "AutoModel", _FakeAutoModel)

    handler_a = object.__new__(ParaformerSTTHandler)
    handler_a.setup(model_name="paraformer-zh", device="cpu", gen_kwargs={})
    handler_b = object.__new__(ParaformerSTTHandler)
    handler_b.setup(model_name="paraformer-zh", device="mps", gen_kwargs={})

    # Different canonical devices → different instances, unless "mps" is
    # unavailable on this host (then it collapses to "cpu" and they share).
    if canonical_device("mps") == "mps":
        assert handler_a._shared is not handler_b._shared
        assert len(instances) == 2
    else:
        assert handler_a._shared is handler_b._shared
        assert len(instances) == 1
