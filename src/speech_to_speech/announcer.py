"""独立语音播报守护进程（Qwen3-TTS CustomVoice，Apple Silicon mlx-audio）。

与语音引擎解耦：常驻加载一次 Qwen3-TTS 模型，通过 stdin JSONL 接收播报
请求，用 sounddevice 播放到默认输出设备。供桌面端在任务完成等时刻驱动。

协议（stdin 每行一条 JSON）：

    {"type": "speak", "text": "任务已完成", "language": "chinese"}
    {"type": "shutdown"}

stdout 输出 JSON 行（用于就绪探测与确认）：

    {"type": "ready", "speaker": "Aiden", "speakers": ["Aiden", ...]}
    {"type": "spoken", "text": "..."}
    {"type": "error", "error": "..."}
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit"


def _resolve_speaker(model: Any, requested: str | None) -> str:
    speakers: list[str] = []
    get_speakers = getattr(model, "get_supported_speakers", None)
    if callable(get_speakers):
        speakers = [str(s) for s in (get_speakers() or []) if s]
    if requested:
        for s in speakers:
            if s.lower() == requested.lower():
                return s
        # 未命中时仍回退到第一个可用音色，避免启动失败
        logger.warning("speaker %r not in %s; falling back", requested, speakers)
    if speakers:
        return speakers[0]
    return requested or "Aiden"


def _synthesize(model: Any, text: str, speaker: str, language: str, max_tokens: int) -> np.ndarray:
    """合成整句并返回 int16 PCM（1D，模型原生采样率由调用方配合 sample_rate 使用）。"""
    chunks: list[np.ndarray] = []
    sample_rate = 24000
    for result in model.generate_custom_voice(
        text=text,
        speaker=speaker,
        language=language,
        max_tokens=max_tokens,
        verbose=False,
    ):
        audio = np.asarray(result.audio).squeeze().astype(np.float32)
        if audio.size == 0:
            continue
        sample_rate = int(result.sample_rate)
        chunks.append(audio)
    if not chunks:
        raise RuntimeError("TTS 未产出音频")
    audio = np.concatenate(chunks)
    return np.clip(audio * 32768, -32768, 32767).astype(np.int16), sample_rate


def main() -> None:
    parser = argparse.ArgumentParser(prog="speech-to-speech announce")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Qwen3-TTS CustomVoice 模型（HF repo id 或路径）")
    parser.add_argument("--speaker", default=None, help="CustomVoice 音色（默认取第一个可用音色）")
    parser.add_argument("--language", default="chinese", help="合成语言（默认 chinese）")
    parser.add_argument("--max-tokens", type=int, default=1024, help="单句最大 codec token 数")
    parser.add_argument("--warmup-text", default="好", help="启动后预热文本（可置空跳过）")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    from mlx_audio.tts.utils import load_model
    import sounddevice as sd

    logger.info("loading Qwen3-TTS model %s", args.model)
    model = load_model(args.model)
    speaker = _resolve_speaker(model, args.speaker)
    logger.info("Qwen3-TTS announce ready (speaker=%s)", speaker)

    # 预热：避免首个播报请求承担编译/加载延迟
    if args.warmup_text:
        try:
            pcm, _sr = _synthesize(model, args.warmup_text, speaker, args.language, args.max_tokens)
            del pcm
            logger.info("announcer warmed up")
        except Exception as exc:  # noqa: BLE001 - 预热失败不应阻断服务
            logger.warning("warmup failed: %s", exc)

    print(
        json.dumps({"type": "ready", "speaker": speaker}, ensure_ascii=False),
        flush=True,
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        mtype = msg.get("type")
        if mtype == "shutdown":
            break
        if mtype != "speak":
            continue

        text = str(msg.get("text", "")).strip()
        if not text:
            continue
        language = str(msg.get("language") or args.language)
        max_tokens = int(msg.get("max_tokens") or args.max_tokens)

        try:
            pcm, sample_rate = _synthesize(model, text, speaker, language, max_tokens)
            sd.play(pcm, sample_rate)
            sd.wait()
            print(json.dumps({"type": "spoken", "text": text}, ensure_ascii=False), flush=True)
        except Exception as exc:  # noqa: BLE001
            logger.exception("speak failed")
            print(json.dumps({"type": "error", "error": str(exc)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
