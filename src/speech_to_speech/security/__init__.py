"""Wake word + voiceprint security for the speech-to-speech pipeline.

The security stage sits in front of VAD and keeps the assistant silent until
the enrolled speaker says the wake word:

- ``wake_word``: sherpa-onnx zipformer KWS (Chinese, custom pinyin keywords).
- ``voiceprint``: 3D-Speaker ERes2NetV2 embeddings via funasr (enroll + verify).
- ``gate``: a pipeline handler that consumes raw audio, runs both checks and
  only forwards audio downstream after the speaker is verified.
"""

from speech_to_speech.security.gate import SecurityGateHandler
from speech_to_speech.security.voiceprint import Voiceprint, VoiceprintProfile
from speech_to_speech.security.wake_word import WakeWordDetector

__all__ = [
    "SecurityGateHandler",
    "Voiceprint",
    "VoiceprintProfile",
    "WakeWordDetector",
]
