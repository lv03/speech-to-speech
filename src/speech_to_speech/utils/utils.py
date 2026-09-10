from __future__ import annotations

import ipaddress
import uuid
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

import numpy as np

if TYPE_CHECKING:
    from openai.types.realtime.realtime_response_create_params import RealtimeResponseCreateParams


def url_host(url: str | None) -> str | None:
    """Return the lowercased hostname of *url*, or ``None`` when it has none."""
    if not url:
        return None
    try:
        hostname = urlsplit(str(url).strip()).hostname
    except ValueError:
        return None
    return hostname.rstrip(".").lower() if hostname else None


def is_local_url(url: str | None) -> bool:
    """Whether *url* points at this machine (loopback hostname or loopback IP)."""
    host = url_host(url)
    if host is None:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def is_local_or_private_url(url: str | None) -> bool:
    """Whether *url* points at loopback or a private/LAN address.

    Used to keep local inference servers out of the caller's proxy environment:
    macOS system proxies (and ``ALL_PROXY``/``*_PROXY``) would otherwise route
    ``127.0.0.1`` requests through a remote proxy, which either fails or leaks
    local traffic off the machine.
    """
    host = url_host(url)
    if host is None:
        return False
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


def response_wants_audio(response: RealtimeResponseCreateParams | None) -> bool:
    """Whether a response should produce audio (and audio events) vs. text only.

    Mirrors the OpenAI realtime semantics for ``output_modalities``: an absent
    value (``None``) or an empty list, or an explicit ``"audio"`` entry means
    audio; a non-empty list without ``"audio"`` (e.g. ``["text"]``) means text
    only.
    """
    if response is None:
        return True
    mods = response.output_modalities
    return not mods or "audio" in mods


def is_out_of_band(response: RealtimeResponseCreateParams | None) -> bool:
    """Whether a response is *out-of-band* (``conversation="none"``).

    Out-of-band responses are generated against a temporary context and are
    never threaded into the default conversation: their ``input`` (if any)
    seeds a throwaway chat, their assistant output is not committed back, and
    their ``conversation_id`` is reported as ``null``. Any other ``conversation``
    value (``"auto"``, ``None``, or an arbitrary id) is treated as in-band.
    """
    return response is not None and response.conversation == "none"


def next_power_of_2(x: int) -> int:
    return 1 if x == 0 else 2 ** (x - 1).bit_length()


def _generate_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def int2float(sound: np.ndarray) -> np.ndarray:
    """
    Taken from https://github.com/snakers4/silero-vad
    """

    abs_max = np.abs(sound).max()
    sound = sound.astype("float32")
    if abs_max > 0:
        sound *= 1 / 32768
    sound = sound.squeeze()  # depends on the use case
    return sound
