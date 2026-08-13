# 启动速查（Startup Guide）

> 组件越来越多后，"怎么启动、用哪个模型"反而成了门槛。本文是一页速查：
> 先给"最快开始"，再给三组件（STT / LLM / TTS）后端对照，最后给独立 ASR/TTS API、
> 流式 ASR 的启动与调用示例。详细参数与设计见 `README.md` 和各 `docs/` 文档。

---

## 0. 三个组件怎么选（一句话）

| 组件 | 选择器 | 常用值 | 默认 |
|---|---|---|---|
| 语音转文字 STT | `--stt` | `parakeet-tdt` / `paraformer` / `fun-asr-nano` / `whisper` | `parakeet-tdt` |
| 大模型 LLM | `--llm_backend` | `mlx-lm`(Mac) / `transformers`(本地) / `responses-api`(云) | `responses-api` |
| 文字转语音 TTS | `--tts` | `qwen3` / `kokoro` / `pocket` / `chatTTS` | `qwen3` |

三个选择器是**正交**的，可任意组合。CLI 只为选中的后端解析参数，其余后端参数会被忽略并告警。

---

## 1. 最快开始

### 1.1 macOS（Apple Silicon，MPS）

```bash
# 首次：安装依赖（funasr 等可选后端才需要）
pip install -e ".[paraformer]"

# 全链路：麦克风 → VAD → STT → LLM → TTS → 扬声器（本机回环）
speech-to-speech local --mac-optimal-settings
```

`--mac-optimal-settings` 会套一组 Mac 预设：`parakeet-tdt`(STT) + `mlx-lm`(LLM) + `qwen3`(TTS)，
并把组件设备设为 `mps`。它只是**默认值**——后面显式传 `--stt`、`--device`、`--model_name` 等会覆盖它。

### 1.2 CUDA / CPU（Linux/Windows）

```bash
export OPENAI_API_KEY=...
speech-to-speech serve          # 默认 parakeet-tdt + responses-api(云 LLM) + qwen3
```

只起服务不起麦克风：用 `serve`。想连麦克风/扬声器：另开终端 `speech-to-speech talk --url ws://127.0.0.1:8765/v1/realtime`。

---

## 2. STT 后端速查

| `--stt` | 模型（实际加载） | 平台 | 需额外装 | 备注 |
|---|---|---|---|---|
| `parakeet-tdt` | `nvidia/parakeet-tdt-0.6b-v3`（CUDA/CPU）/ `mlx-community/parakeet-tdt-0.6b-v3`（MPS） | 全平台 | 无 | 默认；25 种欧洲语言 |
| `paraformer` | `paraformer-zh` → **SEACO-Paraformer-large**（220M，ModelScope） | CUDA/CPU/MPS | `[paraformer]` | 中文向；支持热词、逐字空格输出 |
| `fun-asr-nano` | `FunAudioLLM/Fun-ASR-Nano-2512`（0.8B，HF） | 建议 GPU（MPS 可跑 ~8x 实时） | `[paraformer]` | 中/英/日 + 方言口音；热词；无字级时间戳 |
| `whisper` | HF Whisper（Transformers） | CUDA/CPU | 无 | 通用多语言 |
| `faster-whisper` | faster-whisper | CUDA/CPU | `[faster-whisper]` | 更快 |
| `whisper-mlx` | lightning-whisper-mlx | MPS | `[whisper-mlx]` | Mac |
| `mlx-audio-whisper` | mlx-community/whisper-large-v3-turbo | MPS | 无 | Mac |
| `none` | — | 全平台 | — | 音频直通给音频 LLM |

**两个 FunASR 后端务必注意设备**：在 Mac 上要么用 `--mac-optimal-settings`，要么显式 `--paraformer_stt_device mps` / `--fun_asr_nano_stt_device mps`（否则默认 `cuda` 会回落到 CPU）。

```bash
# paraformer（中文 + 热词）
speech-to-speech serve --stt paraformer \
  --paraformer_stt_device mps \
  --paraformer_stt_gen_hotword "开放时间 脐腐病"

# fun-asr-nano（中英日 + 方言 + 热词）
speech-to-speech serve --stt fun-asr-nano \
  --fun_asr_nano_stt_device mps \
  --fun_asr_nano_stt_gen_language 中文 \
  --fun_asr_nano_stt_gen_hotword "开放时间"
```

---

## 3. TTS 后端速查

| `--tts` | 模型 | 平台 | 需额外装 | 备注 |
|---|---|---|---|---|
| `qwen3` | `Qwen3-TTS-12Hz-1.7B-CustomVoice`（MPS 走 `mlx-community/...-6bit`） | 全平台 | 无 | 默认；支持 CustomVoice/VoiceDesign/克隆 |
| `kokoro` | `Kokoro-82M` | CUDA/CPU/MPS | `[kokoro]`(非 Mac) | 轻量 |
| `pocket` | Pocket TTS | CPU/CUDA | `[pocket]` | 轻量 |
| `chatTTS` | ChatTTS | CUDA/CPU | `[chattts]` | 对话感 |
| `facebookMMS` | MMS TTS | CUDA/CPU | 无 | 多语言（1000+） |

```bash
# 换 TTS 音色/后端
speech-to-speech serve --tts qwen3 --qwen3_tts_speaker Aiden --qwen3_tts_language zh
speech-to-speech serve --tts kokoro
```

---

## 4. LLM 后端速查

| `--llm_backend` | 说明 | 平台 | 备注 |
|---|---|---|---|
| `responses-api` | OpenAI Responses API（默认） | 云/自建 | 需 `OPENAI_API_KEY` + `--model_name` |
| `chat-completions` | OpenAI Chat Completions API | 云/自建 | 同用 `--responses_api_*` 连接参数 |
| `mlx-lm` | 本地 MLX 大模型 | MPS | Mac 推荐；`--model_name mlx-community/...` |
| `transformers` | 本地 HF Transformers | CUDA/CPU | 本地推理 |

```bash
# Mac 全本地
speech-to-speech local --mac-optimal-settings --model_name mlx-community/Qwen3-4B-Instruct-2507-bf16

# 指定云端模型
export OPENAI_API_KEY=...
speech-to-speech serve --llm_backend responses-api --model_name gpt-5.4-mini
```

---

## 5. 独立 ASR/TTS API（本次新增，`--enable_audio_api`）

把本地 STT/TTS 模型暴露成 OpenAI 兼容的 HTTP 接口，供**其他服务**直接调用（不走 VAD→LLM→TTS 链路）。

```bash
speech-to-speech serve --enable_audio_api \
  --stt fun-asr-nano --tts qwen3
```

### 5.1 端点

| 端点 | 用途 |
|---|---|
| `POST /v1/audio/transcriptions` | multipart 音频 → `{"text"}`；`model=fun-asr-nano`(默认) / `paraformer` |
| `POST /v1/audio/speech` | JSON `{model:"qwen3", input, voice}` → `audio/wav` |

### 5.2 用 OpenAI SDK 调用

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8765/v1", api_key="unused")

# 转文字
with open("speech.wav", "rb") as f:
    print(client.audio.transcriptions.create(model="fun-asr-nano", file=f).text)

# 转语音
client.audio.speech.create(model="qwen3", input="你好", voice="Aiden").stream_to_file("out.wav")
```

要点：
- 模型**惰性加载**（首次请求才下载/加载），进程级单例，与 pipeline 共享同一份实例（不重复占显存）。
- 音频解码支持 WAV/FLAC/OGG（MP3 需 ffmpeg）；输出 16kHz WAV。
- **无鉴权**，只在可信网络用。

---

## 6. 流式 ASR（本次新增，WebSocket）

`WS /v1/audio/transcriptions/stream`：二进制 int16 PCM（16kHz）推入 → `speech_started` / `partial` / `final` JSON 吐出。

| 模式 | `model` | partial 来源 | final 来源 |
|---|---|---|---|
| VAD + 整段重转写 | `fun-asr-nano` / `paraformer` | 逐步全量重转写（干净） | 整段离线（干净） |
| **真 chunk 流式 + 离线 final** | `paraformer-online` | paraformer-zh-online 增量（低延迟，边界有轻微重叠） | `final_model`（默认 `fun-asr-nano`）离线重转写（干净） |

```bash
speech-to-speech serve --enable_audio_api --stt fun-asr-nano --tts qwen3
```

```python
import wave, numpy as np
from websockets.sync.client import connect

with wave.open("speech.wav", "rb") as w:
    pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)

url = "ws://localhost:8765/v1/audio/transcriptions/stream?model=paraformer-online&final_model=fun-asr-nano&language=中文&hotwords=开放时间"
with connect(url) as ws:
    for i in range(0, len(pcm), 9600):
        ws.send(pcm[i:i+9600].tobytes())
    ws.send('{"type":"stop"}')
    for _ in range(50):
        msg = ws.recv()
        print(msg)          # {"type":"partial","text":...} / {"type":"final","text":...}
        if '"final"' in msg:
            break
```

---

## 7. 模型下载与缓存

- 首次启动会自动下载模型，**耗时较长**（Fun-ASR-Nano ~800MB，Qwen3-TTS 数 GB）。
- 缓存位置：
  - HuggingFace：`~/.cache/huggingface/hub/`
  - ModelScope：`~/.cache/modelscope/`
  - torch.hub（Silero VAD）：`~/.cache/torch/hub/`
- 已下载后再次启动只需加载，不再联网（可设 `HF_HUB_OFFLINE=1` 强制离线）。

---

## 8. 常见组合示例

```bash
# 1) Mac 全本地语音助手（默认预设）
speech-to-speech local --mac-optimal-settings

# 2) Mac 全本地 + 中文 ASR（SEACO-Paraformer）+ 热词
speech-to-speech local --mac-optimal-settings \
  --stt paraformer \
  --paraformer_stt_gen_hotword "开放时间 脐腐病"

# 3) Mac 全本地 + Fun-ASR-Nano（中英日/方言）
speech-to-speech local --mac-optimal-settings \
  --stt fun-asr-nano --fun_asr_nano_stt_gen_language 中文

# 4) 只起服务，对外提供 全链路 Realtime + 独立 ASR/TTS API
speech-to-speech serve --host 0.0.0.0 \
  --stt fun-asr-nano --llm_backend responses-api --tts qwen3 \
  --enable_audio_api

# 5) 完全本地 + 独立 API（不连麦克风）
speech-to-speech serve --stt fun-asr-nano --llm_backend mlx-lm \
  --model_name mlx-community/Qwen3-4B-Instruct-2507-bf16 --tts qwen3 \
  --enable_audio_api
```
