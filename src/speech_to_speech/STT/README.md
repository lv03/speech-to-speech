# STT Summary

This document summarizes the Speech-to-Text (STT) implementations in the `STT/` folder, including language support, language abbreviations, and usage in `s2s_pipeline.py`.

## Available STT Modes (`--stt`)

- `whisper` → `STT/whisper_stt_handler.py`
- `whisper-mlx` → `STT/lightning_whisper_mlx_handler.py`
- `mlx-audio-whisper` → `STT/mlx_audio_whisper_handler.py`
- `faster-whisper` → `STT/faster_whisper_handler.py`
- `parakeet-tdt` → `STT/parakeet_tdt_handler.py`
- `paraformer` → `STT/paraformer_handler.py`
- `fun-asr-nano` → `STT/fun_asr_nano_handler.py`

## Language Support by Handler

### 1) Whisper (`--stt whisper`)

- Handler: `WhisperSTTHandler`
- Language input flag: `--language` (from shared Whisper args)
- Supports fixed language (e.g. `en`) or `auto`
- Internal supported language list:
  - `en`, `fr`, `es`, `zh`, `ja`, `ko`, `hi`, `de`, `pt`, `pl`, `it`, `nl`
- Behavior:
  - Detects language from token output
  - If detected language is outside the supported list, it falls back to the previous language

### 2) Lightning Whisper MLX (`--stt whisper-mlx`)

- Handler: `LightningWhisperSTTHandler`
- Uses same shared `--language` argument as Whisper
- Internal supported language list:
  - `en`, `fr`, `es`, `zh`, `ja`, `ko`, `hi`, `de`, `pt`, `pl`, `it`, `nl`
- Behavior:
  - If `--language auto`, model auto-detects each utterance
  - If detected language is unsupported, falls back to last supported language

### 3) MLX Audio Whisper (`--stt mlx-audio-whisper`)

- Handler: `MLXAudioWhisperSTTHandler`
- Model flag: `--mlx_audio_whisper_model_name`
- Language still comes from shared `--language` flag (wired in pipeline)
- Internal supported language list:
  - `en`, `fr`, `es`, `zh`, `ja`, `ko`, `hi`, `de`, `pt`, `pl`, `it`, `nl`
- Behavior:
  - Uses fixed language unless `--language auto`
  - Falls back to last known supported language when needed

### 4) Faster-Whisper (`--stt faster-whisper`)

- Handler: `FasterWhisperSTTHandler`
- Language flag: `--faster_whisper_stt_gen_language`
- Default language: `en`
- Note:
  - This handler passes generation kwargs directly to `faster_whisper.WhisperModel.transcribe(...)`
  - Effective language coverage depends on selected Faster-Whisper/OpenAI Whisper model

### 5) Parakeet TDT (`--stt parakeet-tdt`)

- Handler: `ParakeetTDTSTTHandler`
- Language flag: `--parakeet_tdt_language` (optional)
- Supports auto language detection when language not specified
- Declared supported language list (25 European languages):
  - `en`, `de`, `fr`, `es`, `it`, `pt`, `nl`, `pl`, `ru`, `uk`, `cs`, `sk`, `hu`, `ro`, `bg`, `hr`, `sl`, `sr`, `da`, `no`, `sv`, `fi`, `et`, `lv`, `lt`
- Backend behavior:
  - On macOS/MPS: MLX (`mlx-community/parakeet-tdt-0.6b-v3`)
  - On CUDA/CPU: nano-parakeet (`nvidia/parakeet-tdt-0.6b-v3`)

### 6) Paraformer (`--stt paraformer`)

- Handler: `ParaformerSTTHandler`
- Model flag: `--paraformer_stt_model_name`
- Default model: `paraformer-zh`
- No dedicated language flag in current args class
- Practical support:
  - Depends on selected FunASR model checkpoint
  - Default setup is Chinese-oriented (`zh`)
- **Exact model (don't confuse with plain Paraformer-large)**
  - The handler does not pass `hub`, so it defaults to ModelScope, where
    `paraformer-zh` resolves to `iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch`
    — **SEACO-Paraformer-large** (`model: SeacoParaformer`), 220M params, 8404 vocab, 60k hours.
  - SEACO adds a semantic bias encoder for hotword customization and emits
    **per-character-spaced Chinese** (`"皮 酒 病"`) — which is why the handler has
    `_space_each()` hotword normalization and joins the output with `.replace(" ", "")`.
  - Alias map:
    - `paraformer` (no `-zh`) → plain `Paraformer-large` (220M, no char-spacing, no semantic bias)
    - `paraformer-zh` → **SEACO-Paraformer-large** (this repo's default)
  - **Hub pitfall**: the same `paraformer-zh` resolves to `funasr/paraformer-zh` (plain
    Paraformer, no char-spacing) on HuggingFace. Switching to `hub="hf"` (or passing
    `funasr/paraformer-zh` directly) would change the model and break the hotword
    spacing normalization.

### 7) Fun-ASR-Nano (`--stt fun-asr-nano`)

- Handler: `FunASRNanoSTTHandler`
- Model flag: `--fun_asr_nano_stt_model_name`
- Default model: `FunAudioLLM/Fun-ASR-Nano-2512` (HuggingFace)
- Device flag: `--fun_asr_nano_stt_device` (`cuda`, `mps`, or `cpu`)
- Hub flag: `--fun_asr_nano_stt_hub` (`hf` or `ms`)
- Language flag: `--fun_asr_nano_stt_gen_language` (e.g. `中文`, `en`, `auto`)
- Hotwords: `--fun_asr_nano_stt_gen_hotword` (space-separated) or
  `--fun_asr_nano_stt_gen_hotword_file` (one term per line)
- Practical support:
  - LLM-based ASR (~0.8B): zh/en/ja plus 7 Chinese dialect groups and 26 accents
  - 31-language coverage requires the separate `FunAudioLLM/Fun-ASR-MLT-Nano-2512` checkpoint
  - Requires `funasr>=1.4.0` (installed via `pip install speech-to-speech[paraformer]`)
  - GPU recommended; the PyTorch CPU path runs ~3.6x realtime
  - No reliable character-level timestamps (upstream issue #106)

## Language Abbreviations (ISO-style codes seen in STT handlers)

| Code | Language |
|---|---|
| `en` | English |
| `fr` | French |
| `es` | Spanish |
| `zh` | Chinese |
| `ja` | Japanese |
| `ko` | Korean |
| `hi` | Hindi |
| `de` | German |
| `pt` | Portuguese |
| `pl` | Polish |
| `it` | Italian |
| `nl` | Dutch |
| `ru` | Russian |
| `uk` | Ukrainian |
| `cs` | Czech |
| `sk` | Slovak |
| `hu` | Hungarian |
| `ro` | Romanian |
| `bg` | Bulgarian |
| `hr` | Croatian |
| `sl` | Slovenian |
| `sr` | Serbian |
| `da` | Danish |
| `no` | Norwegian |
| `sv` | Swedish |
| `fi` | Finnish |
| `et` | Estonian |
| `lv` | Latvian |
| `lt` | Lithuanian |
| `auto` | Per-utterance automatic language detection |

## Usage Examples

### Whisper (Transformers)

```bash
speech-to-speech serve --stt whisper --language en
speech-to-speech serve --stt whisper --language auto
```

### Whisper MLX (LightningWhisperMLX)

```bash
speech-to-speech serve --stt whisper-mlx --language auto --device mps
```

### MLX Audio Whisper

```bash
speech-to-speech serve --stt mlx-audio-whisper \
  --mlx_audio_whisper_model_name mlx-community/whisper-large-v3-turbo \
  --language auto
```

### Faster-Whisper

```bash
speech-to-speech serve --stt faster-whisper \
  --faster_whisper_stt_model_name large-v3 \
  --faster_whisper_stt_gen_language en
```

### Parakeet TDT

```bash
speech-to-speech serve --stt parakeet-tdt --parakeet_tdt_device auto
speech-to-speech serve --stt parakeet-tdt --parakeet_tdt_language de
```

With live transcription (MLX or CUDA/nano-parakeet backend):

```bash
speech-to-speech serve --stt parakeet-tdt \
  --enable_live_transcription \
  --live_transcription_update_interval 0.25
```

### Paraformer

```bash
speech-to-speech serve --stt paraformer --paraformer_stt_model_name paraformer-zh
```

### Fun-ASR-Nano

```bash
speech-to-speech serve --stt fun-asr-nano \
  --fun_asr_nano_stt_device cuda \
  --fun_asr_nano_stt_gen_language 中文 \
  --fun_asr_nano_stt_gen_hotword "开放时间 脐腐病"
```

On Apple Silicon the macOS preset defaults the device to MPS:

```bash
speech-to-speech serve --stt fun-asr-nano --mac-optimal-settings
```
