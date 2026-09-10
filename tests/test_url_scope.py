"""URL scope helpers keep local inference endpoints out of proxy configurations."""

import pytest

from speech_to_speech.utils.utils import is_local_or_private_url, is_local_url, url_host


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8000/v1",
        "http://127.0.0.1:8000/v1",
        "http://127.1.2.3:8000/v1",
        "http://[::1]:8000/v1",
        "http://LOCALHOST:8000/v1",
        "http://localhost.:8000/v1",
    ],
)
def test_is_local_url_accepts_loopback_endpoints(url: str) -> None:
    assert is_local_url(url) is True


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1",
        "http://10.0.0.5:8000/v1",
        "http://192.168.1.20:8000/v1",
        "ws://voice.example/v1/realtime",
        "",
        None,
    ],
)
def test_is_local_url_rejects_non_loopback_endpoints(url) -> None:
    assert is_local_url(url) is False


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/v1",
        "http://localhost:8000/v1",
        "http://10.0.0.5:8000/v1",
        "http://172.16.4.9:8000/v1",
        "http://192.168.1.20:8000/v1",
        "http://169.254.10.1:8000/v1",
    ],
)
def test_is_local_or_private_url_covers_loopback_and_lan(url: str) -> None:
    assert is_local_or_private_url(url) is True


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1",
        "https://router.huggingface.co/v1",
        "http://8.8.8.8:8000/v1",
        "ws://voice.example/v1/realtime",
    ],
)
def test_is_local_or_private_url_keeps_remote_endpoints_proxied(url: str) -> None:
    assert is_local_or_private_url(url) is False


def test_url_host_normalizes_case_and_trailing_dot() -> None:
    assert url_host("http://LocalHost.:8000/v1") == "localhost"
    assert url_host("not a url") is None
    assert url_host(None) is None
