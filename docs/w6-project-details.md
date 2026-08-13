# W6 学习讲义 —— 项目细节与模拟面试

> 配套：[面试准备清单](interview-prep.md) F1-F7 · 收官周：背项目细节 + 全真模拟
> 周验收：连续答 10 道 grilling 追问不断片、脱口而出后端名单与启动命令

---

## F1 模型切换经历（三段完整版，核心素材）

> 讲述模板：**为什么切 → 遇到什么 → 怎么解决 → 结果**。每段 1 分钟。

### ① STT：Parakeet → Paraformer（中文场景）

> "默认的 Parakeet 覆盖 25 种欧洲语言但不擅长中文，中文场景切到 FunASR 的 Paraformer。遇到三个问题：一是**设备参数**，Paraformer 的 device 默认 cuda，Apple Silicon 上必须显式传 mps，否则启动直接报错；二是**模型解析**，传 `paraformer-zh` 别名，FunASR 1.4 实际加载的是 SEACO 增强版（带说话人嵌入的变体）而不是普通版，要确认实际 repo；三是**性能**，Paraformer 在 MPS 上推理 RTF≈55，长句被 VAD 切段后最终转写迟到 2-4 秒，响应基于不完整转写。最后通过调 VAD 参数缓解，也评估了换更快的 STT 方案。"

### ② LLM：llama.cpp → vLLM（本地 vs 远程）

> "同一个 OpenAI 兼容接口下，两个后端行为差异很大。一是**格式**，llama.cpp 要 GGUF（ModelScope 下 Q8_0 639MB），vLLM 远程用 safetensors 服务化部署；二是**思考开关**，Qwen3 默认会输出 reasoning，项目通过 `chat_template_kwargs.enable_thinking=false` 关，但 llama.cpp 还需要 `--reasoning off` 服务器级兜底，两个后端都要实测确认；三是**模型能力**，0.6B 在多轮对话下退化成复述用户输入——我用对照实验定位（单轮正常、带历史就复述），换 8B 解决。"

### ③ TTS：HF 权重 → MLX 权重（Apple Silicon）

> "Qwen3-TTS 在 Apple Silicon 走 mlx-audio，需要 MLX 转换版权重（`-6bit` 后缀），不能直接喂 HF safetensors。而且模型有三种变体：Base 必须给参考音频做声音克隆、CustomVoice 用预置音色、VoiceDesign 用自然语言指令控制音色语调——能力差异很大，选型要看需求。"

---

## F2 身份与边界（背 P0-6 话术 + 要点）

- **模块边界**：语音输入 → 活动检测 → 识别 → 生成 → 合成 → 音频+事件流给数字人前端
- **不 claim 视觉**：口型/形象是团队其他成员，被问就明确分工
- **开源坦诚**：参考 speech-to-speech 方案，但选型/双后端接入/问题定位/文档化是实际工作
- **话术**：见 [P0-6 速记卡](interview-prep.md)

---

## F3 后端名单（脱口而出，必背）

### 6 种 STT

| 名字 | 一句话 |
|---|---|
| `parakeet-tdt`（默认） | 25 种欧洲语言，MPS 走 MLX / CUDA 走 nano-parakeet |
| `whisper` | Transformers 实现，12 语言，支持 torch.compile |
| `faster-whisper` | CTranslate2，最快，不报语言 |
| `whisper-mlx` | Lightning Whisper MLX，Apple Silicon |
| `mlx-audio-whisper` | mlx-audio 版，Apple Silicon |
| `paraformer` | FunASR，中文向（本项目实际用的） |

### 4 种 LLM

| 名字 | 一句话 |
|---|---|
| `transformers` | 本地 Python 推理，全平台 |
| `mlx-lm` | Apple Silicon 默认 |
| `responses-api` | OpenAI 兼容 /v1/responses（本项目实际用的） |
| `chat-completions` | OpenAI 兼容 /v1/chat/completions，支持音频输入 |

### 5 种 TTS

| 名字 | 一句话 |
|---|---|
| `qwen3`（默认） | 三变体（克隆/预设/指令），本项目实际用的 |
| `kokoro` | 8 语言预置音色，自动切换 |
| `pocket` | Kyutai 轻量，CPU 优先 |
| `facebookMMS` | ~40 语言，按语言重载模型 |
| `chatTTS` | 中文对话风格 |

---

## F4 启动命令（背 W5 E4 的完整命令）

```bash
# 1. LLM 后端（二选一）
llama-server -m <GGUF路径> -c 8192 --port 8080 --reasoning off
#   或连接远程 vLLM（--responses_api_base_url http://192.168.8.88:8005/v1）

# 2. 项目
speech-to-speech serve \
  --stt paraformer \
  --paraformer_stt_device mps \
  --llm_backend responses-api \
  --responses_api_base_url "http://127.0.0.1:8080/v1" \
  --responses_api_api_key "" \
  --model_name "Qwen3:8B" \
  --qwen3_tts_model_name ~/.cache/modelscope/models/mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit/snapshots/master \
  --no_smart_turn
```

**参数含义**：`--paraformer_stt_device mps`（mac 必填，默认 cuda）；`--llm_backend`（默认 responses-api）；`--qwen3_tts_model_name`（本地目录，mlx-audio 直接吃）；`--no_smart_turn`（跳过 HF 下载的分类器）。

---

## F5 性能数据溯源（背 W5 E5 表）

```
TTFA 0.3s 级   ← Qwen3-TTS 首块音频实测 0.31-0.37s（TTFA 日志）
TTS RTF 1.15-2.13 ← 合成 5.81s 音频耗时 2.72s（实测）
STT RTF ≈55    ← paraformer MPS 全量推理（瓶颈，切经历素材）
LLM 0.2s/1.0s  ← llama.cpp 0.6B 本地 / vLLM 8B 远程（实测）
```

---

## F6 前端 demo 机制（简历没写但可能被问）

### 结构

```
demo/index.html + main.js（单页 UI：orb 可视化 / 字幕 / 工具按钮）
demo/ws/s2s-ws-client.js（WebSocket 客户端，核心）
demo/server.py（FastAPI 代理：静态文件 + WebRTC SDP 转发 /api/calls + OAuth）
demo/worklets/（AudioWorklet：麦克风采集 / 播放）
```

### 客户端核心流程（能讲）

```
1. 连接 ws://.../v1/realtime → 收 session.created
2. 发 session.update（GA schema）→ 之后才允许发音频
3. 麦克风 AudioWorklet 采集 → PCM16 16k base64 → input_audio_buffer.append（每 ~40ms 一帧）
4. 浏览器维护已发帧的内存副本 → 用服务端 speech_started/stopped 边界做可重放的用户录音
5. 收 response.output_audio.delta（24k base64）→ AudioContext 解码播放
6. 渲染 output_audio_transcript.delta（TTS 字幕）+ transcription.delta（用户实时转写）
```

---

## F7 工具链（环境问题，被问概率低但要会）

| 工具 | 用法 |
|---|---|
| uv | `uv sync`（按 uv.lock 装依赖）、`uv venv`、`uv pip install -r` |
| pip extras | `speech-to-speech[paraformer]`（FunASR）/ `[webrtc]`（aiortc）/ `[mlx-lm]` |
| modelscope CLI | `modelscope download --model <org>/<name>` → 缓存 `~/.cache/modelscope/models/` |
| 测试 | WebSocket 脚本模拟音频输入（say 生成中文 wav → append → commit → 观察事件流） |

---

## 模拟面试（周验收）

### 10 道核心 grilling 题（逐题脱稿）

1. 为什么线程+队列不是全异步？→ P0-1
2. 讲一次真实模型切换经历 → F1
3. 首音频延迟怎么压到 0.3s？→ P0-3 + W2 B1
4. 打断时怎么保证一致性？→ P0-4 + W3 C2
5. 为什么用 OpenAI Realtime 协议？→ P0-5 + W4 D1
6. WebSocket 和 WebRTC 为什么都要？→ W4 D2
7. 加一个新后端要改什么？→ W3 C3
8. MLX 并发为什么危险？→ W3 C5
9. 这个项目是开源的？→ P0-6 / F2
10. 口型同步怎么做的？→ F2（团队分工）

### 扩展题（答出 2-3 个即加分）

- 0.6B 为什么复述？怎么定位的？（对照实验：单轮正常/带历史复述）
- 会话释放为什么等 SESSION_END？（跨会话泄漏）
- RTF/TTFA 分别是什么？你的实测值？（W5 E5）
- demo 前端怎么接的？（F6）
- 模型离线部署思路？（W5 E4）
- 0.3s 延迟的四个手段分别是什么？（P0-3）

### 演练建议

1. **录音自测**：每道题讲 2 分钟录音，回听检查卡壳处
2. **找真人 grilling**：让朋友/同事用 grilling 模式连问，模拟压力
3. **时间控制**：主问答题控制在 1-2 分钟，别超（面试官要控制节奏）

---

## W6 验收清单（全部完成 = 可以面试）

| ☐ | 项目 |
|---|---|
| ☐ | F1 三段切换经历脱稿（每段 1 分钟） |
| ☐ | F2 身份话术（P0-6）脱稿 |
| ☐ | F3 后端名单脱口而出（6+4+5） |
| ☐ | F4 完整启动命令默写 |
| ☐ | F5 实测数据表背诵 |
| ☐ | F6 demo 客户端流程能讲 |
| ☐ | F7 工具链基础 |
| ☐ | 10 道核心题逐题脱稿 |
| ☐ | 输出物清单补齐（图/话术卡/命令卡/数据记录） |

---

*W6 讲义完 · 六周路线全部结束，进入实战演练阶段*
