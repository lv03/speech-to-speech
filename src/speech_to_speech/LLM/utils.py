import base64
import io
import logging
import re
from typing import Any, Optional

import requests  # type: ignore[import-untyped]
from PIL import Image

logger = logging.getLogger(__name__)

SMART_PUNCT_TRANSLATION = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
    }
)

SPEECHABLE_PATTERN = re.compile(
    r"[^\w\s.,!?;:'\"\-()\/\\@#%&*+=$€£¥₹₽¢\[\]{}<>~`^|…—–，。！？；：、\n\r\t]",
    flags=re.UNICODE,
)


def remove_unspeechable(text: str) -> str:
    """Keep only speechable characters: letters, digits, punctuation, whitespace.
    support unicode characters (english, arabic, chinese, japanese, korean, etc.)
    """
    text = text.translate(SMART_PUNCT_TRANSLATION)
    return SPEECHABLE_PATTERN.sub("", text)


# ---------------------------------------------------------------------------
# Multilingual sentence segmentation (SaT) with nltk fallback
#
# nltk's Punkt tokenizer has no Chinese model, so Chinese LLM output would never
# be sentence-split (the whole utterance stayed one "sentence"), which broke
# streaming TTS batching for Chinese dialogue. wtpsplit's SaT (Segment Any Text)
# is a punctuation-agnostic multilingual sentence segmenter covering 85
# languages (zh/en included); `sat-3l-sm` is the balanced speed/quality pick.
# When wtpsplit is not installed, fall back to nltk's English Punkt so the
# pipeline keeps working for English-only setups.
# ---------------------------------------------------------------------------

_SAT_MODEL_NAME = "sat-3l-sm"

_sat: Any = None
_sat_failed: Optional[Exception] = None


def _get_sat() -> Any:
    """Lazily load the SaT segmenter once; cache success or failure."""
    global _sat, _sat_failed
    if _sat is not None or _sat_failed is not None:
        return _sat
    try:
        from wtpsplit import SaT

        _sat = SaT(_SAT_MODEL_NAME)
        logger.info("Loaded SaT sentence segmenter (%s)", _SAT_MODEL_NAME)
    except Exception as exc:  # noqa: BLE001 - any failure degrades to nltk
        _sat_failed = exc
        logger.warning(
            "SaT sentence segmenter unavailable (%s: %s); "
            "falling back to nltk sent_tokenize (English-only splitting)",
            type(exc).__name__,
            exc,
        )
        return None
    return _sat


def preload_sat() -> None:
    """Load the SaT segmenter eagerly.

    Called during pipeline construction so the first conversational turn does
    not pay the multi-second lazy load; the cached loader makes this a no-op
    on every later call.
    """
    _get_sat()


def sent_tokenize(text: str) -> list[str]:
    """Segment *text* into sentences, multilingual.

    Uses SaT when available (punctutation-agnostic, 85 languages incl. zh/en),
    falling back to nltk's English Punkt otherwise.
    """
    if not text:
        return []
    sat = _get_sat()
    if sat is not None:
        try:
            # SaT keeps trailing whitespace on each segment (e.g. "Hello. "),
            # while nltk's sent_tokenize strips it. Normalize to match nltk so
            # the whitespace-preserving stream batching in the LLM handlers does
            # not double spaces when re-joining sentences.
            return [sentence.strip() for sentence in sat.split(text) if sentence.strip()]
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "SaT split failed (%s: %s); falling back to nltk", type(exc).__name__, exc,
            )
    from nltk import sent_tokenize as _nltk_sent_tokenize

    return _nltk_sent_tokenize(text)


# Maps an STT language code to the language name used in the "Please reply ... in {name}"
# prompt. Every language any bundled STT backend can report needs an entry here, otherwise
# `--enable_lang_prompt` silently emits no instruction for it. The names are lowercase
# because they are interpolated mid-sentence.
#
# `tests/test_llm_utils.py` asserts this covers the SUPPORTED_LANGUAGES of every bundled STT
# handler, so adding a language to a handler without adding it here fails CI.
WHISPER_LANGUAGE_TO_LLM_LANGUAGE = {
    "en": "english",
    "fr": "french",
    "es": "spanish",
    "zh": "chinese",
    "ja": "japanese",
    "ko": "korean",
    "hi": "hindi",
    "de": "german",
    "pt": "portuguese",
    "pl": "polish",
    "it": "italian",
    "nl": "dutch",
    # The remaining languages Parakeet TDT v3 (the default STT) detects and reports.
    "ru": "russian",
    "uk": "ukrainian",
    "cs": "czech",
    "sk": "slovak",
    "hu": "hungarian",
    "ro": "romanian",
    "bg": "bulgarian",
    "hr": "croatian",
    "sl": "slovenian",
    "sr": "serbian",
    "da": "danish",
    "no": "norwegian",
    "sv": "swedish",
    "fi": "finnish",
    "et": "estonian",
    "lv": "latvian",
    "lt": "lithuanian",
}


def resolve_auto_language(language_code: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Strip the ``-auto`` suffix and resolve the human-readable language name.

    Returns ``(clean_code, language_name)``.  ``language_name`` is non-None
    when the code (with or without ``-auto``) maps to a known language.
    """
    if not language_code:
        return language_code, None
    if language_code.endswith("-auto"):
        language_code = language_code[:-5]
    if language_code not in WHISPER_LANGUAGE_TO_LLM_LANGUAGE:
        return language_code, None
    return language_code, WHISPER_LANGUAGE_TO_LLM_LANGUAGE.get(language_code)


def image_url_to_pil(image_url: str) -> Image.Image:
    """Convert an image URL or base64 data URI to a PIL Image.

    Accepts:
    - 'data:image/...;base64,<b64>' data URIs
    - 'https://...`` or ``http://...' URLs (fetched with a 10s timeout)
    """
    if image_url.startswith("data:"):
        _, b64_data = image_url.split(",", 1)
        return Image.open(io.BytesIO(base64.b64decode(b64_data)))
    resp = requests.get(image_url, timeout=10)
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content))
