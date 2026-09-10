"""Local LLM endpoints must not inherit the caller's proxy environment.

The OpenAI SDK builds its httpx client with ``trust_env=True``. On macOS a
system-wide proxy (and ``ALL_PROXY``/``*_PROXY``) is therefore applied to
requests aimed at a local inference server, and a SOCKS proxy makes client
construction itself raise unless ``socksio`` is installed - which aborted voice
engine startup before any request was sent.
"""

import pytest

import speech_to_speech.LLM.base_openai_compatible_language_model as llm_module
from speech_to_speech.LLM.responses_api_language_model import ResponsesApiModelHandler


@pytest.fixture
def _captured_client(monkeypatch):
    captured: dict[str, object] = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(llm_module, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(ResponsesApiModelHandler, "warmup", lambda self: None)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    return captured


def _build_handler(**overrides):
    handler = object.__new__(ResponsesApiModelHandler)
    kwargs = {"request_timeout_s": 12.0, **overrides}
    handler.setup(**kwargs)
    return handler


@pytest.mark.parametrize(
    "base_url",
    [
        "http://127.0.0.1:8000/v1",
        "http://localhost:8000/v1",
        "http://10.0.0.5:8000/v1",
        "http://192.168.1.30:8000/v1",
    ],
)
def test_local_and_lan_endpoints_ignore_proxy_environment(_captured_client, base_url: str) -> None:
    _build_handler(base_url=base_url)

    http_client = _captured_client["http_client"]
    assert http_client._trust_env is False


@pytest.mark.parametrize(
    "base_url",
    ["https://api.openai.com/v1", "https://router.huggingface.co/v1"],
)
def test_remote_endpoints_keep_proxy_environment(_captured_client, base_url: str) -> None:
    _build_handler(base_url=base_url)

    assert _captured_client["http_client"] is None


def test_local_endpoint_client_construction_survives_a_socks_proxy(monkeypatch, _captured_client) -> None:
    """Guard the exact regression: a SOCKS proxy must not break construction."""
    from openai import OpenAI as RealOpenAI

    monkeypatch.setattr(llm_module, "OpenAI", RealOpenAI)
    monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1:7890")
    monkeypatch.setenv("HTTPS_PROXY", "socks5://127.0.0.1:7890")
    monkeypatch.setattr(ResponsesApiModelHandler, "warmup", lambda self: None)

    handler = _build_handler(base_url="http://127.0.0.1:8000/v1")

    assert handler.client.base_url.host == "127.0.0.1"


def test_local_endpoint_still_gets_a_placeholder_api_key(_captured_client) -> None:
    _build_handler(base_url="http://127.0.0.1:8000/v1")

    assert _captured_client["api_key"] == "none"
