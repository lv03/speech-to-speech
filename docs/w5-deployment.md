# W5 学习讲义 —— 部署与推理实战

> 配套：[面试准备清单](interview-prep.md) E1-E5 · 本周是**动手周**：复跑部署 + 记录实测数据
> 周验收：能现场启动全链路 + 报出 TTFA/RTF 实测值
> 数据来源：本机（Apple Silicon M4 系，macOS 15.1）实际部署记录

---

## E1 llama.cpp 部署

### 安装与模型

```bash
brew install llama.cpp                      # 提供 llama-server

# GGUF 模型走 ModelScope 下载（国内快）
modelscope download --model Qwen/Qwen3-0.6B-GGUF
# → ~/.cache/modelscope/models/Qwen--Qwen3-0.6B-GGUF/snapshots/master/Qwen3-0.6B-Q8_0.gguf (639MB)
```

### 启动命令（要能报出每个参数含义）

```bash
llama-server \
  -m ~/.cache/modelscope/models/Qwen--Qwen3-0.6B-GGUF/snapshots/master/Qwen3-0.6B-Q8_0.gguf \
  -c 8192 \              # 上下文窗口
  --port 8080 \
  --host 127.0.0.1 \
  --reasoning off        # 服务器级关闭思考（关键！Qwen3 默认 auto 会思考）
```

### 端点支持（实测）

| 端点 | 状态 |
|---|---|
| `GET /v1/models` | ✅ |
| `POST /v1/chat/completions` | ✅ 老版本就有 |
| `POST /v1/responses` | ✅ 新版（本项目默认后端用它） |
| 请求级关思考 | ✅ `chat_template_kwargs: {"enable_thinking": false}`（实测生效，reasoning_tokens=0） |

### 实测性能

- 0.6B Q8_0：单轮响应 ~0.2s（本机）
- 注意：0.6B 多轮对话会退化复述（能力边界，见 F1）

---

## E2 vLLM 部署

### 形态

```
vLLM 以服务化部署（本场景：远程 192.168.8.88:8005，模型 Qwen3:8B）
OpenAI 兼容三端点：/v1/models、/v1/chat/completions、/v1/responses
```

### 与 llama.cpp 的差异（面试对比）

| | llama.cpp | vLLM |
|---|---|---|
| 定位 | 单机/低资源 | 生产级高并发 |
| 批处理 | 有（连续批） | **PagedAttention**（显存高效批处理） |
| 部署 | 本机进程 | 服务化（可远程） |
| 模型名 | 本地路径 | `--served-model-name` 配置（请求里的 model 名） |
| 思考开关 | `--reasoning off` + chat_template_kwargs | chat_template_kwargs（实测生效） |

### 实测

- 远程 8B：单轮响应 ~1.0s（局域网）
- `/v1/responses` 返回 `reasoning` + `message` 两块；`enable_thinking=false` 时 `reasoning_tokens=0`

---

## E3 MLX 部署（Apple Silicon 专用）

### 核心认知

```
MLX = Apple 的 ML 框架（Metal 加速），专跑 Apple Silicon
mlx-lm（LLM）/ mlx-audio（TTS/STT）是上层库
【关键】MLX 需要【MLX 转换权重】，不能直接用 HF safetensors：
  · Qwen3-TTS 需 mlx-community 转换版（-6bit 后缀）
  · 普通版 HF 权重 → 本地路径直接喂 mlx 大概率失败
```

### 本机实际路径

```bash
# TTS 用 ModelScope 下 MLX 转换版（实测可用，加载成功）
modelscope download --model mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit
# → ~/.cache/modelscope/models/mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit/snapshots/master
# 项目里用 --qwen3_tts_model_name <该目录>（mlx-audio 直接吃本地目录）
```

### 并发安全（E3 与 W3 C5 联动）

```
MLX 单一 Metal 命令队列 → 并发推理崩进程 → 全局锁 MLXLockContext 串行
项目差异策略：progressive 10ms 短超时 / final 5s / TTS 10s
```

---

## E4 ModelScope / HF 缓存（离线部署核心）

### 目录结构（实测）

```
~/.cache/modelscope/models/
├── iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/
│   └── snapshots/master/          ← 模型文件在这里（model.pt 953MB）
├── mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit/
│   └── snapshots/master/          ← model.safetensors 1.15GB
└── Qwen--Qwen3-0.6B-GGUF/
    └── snapshots/master/          ← Qwen3-0.6B-Q8_0.gguf 639MB
```

### 环境变量

| 变量 | 作用 |
|---|---|
| `HF_HOME` / `HF_HUB_CACHE` | 改 HF 缓存位置（`~/.cache/huggingface/hub`） |
| `MODELSCOPE_CACHE` | 改 ModelScope 缓存位置 |
| `HF_HUB_OFFLINE=1` | 强制离线（防止意外联网下载） |

### 离线部署思路（面试可讲）

```
1. 联网机器用 modelscope 下全量模型到缓存
2. 整体拷贝缓存目录到目标机（对应位置）
3. 全部用本地路径传参（--model_name <本地目录>）+ HF_HUB_OFFLINE=1
4. VAD（torch hub 缓存）/ SmartTurn（可 --no_smart_turn 跳过）提前备好
```

### 项目完整启动命令（F4 关联，要能背）

```bash
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

---

## E5 RTF / TTFA 指标（实测值表）

| 指标 | 定义 | 实测值（本机） |
|---|---|---|
| **TTFA** | 首音频延迟：用户说完 → 第一块音频到达 | **0.3s 级**（Qwen3-TTS warmup 后 0.31-0.37s） |
| **RTF** | 实时率：合成音频时长 / 生成耗时（<1 表示快于实时） | Qwen3-TTS 合成 RTF 1.15~2.13（6bit 0.6B） |
| **STT RTF** | 转写耗时 / 音频时长 | paraformer MPS ≈55（慢！1s 音频 3.3s） |
| **LLM 延迟** | 请求到首个 token | llama.cpp 0.6B ~0.2s / vLLM 8B 远程 ~1.0s |

### 这些数据说明什么（面试串联）

```
TTFA 0.3s 靠：句子分批 + 渐进转写复用 + TTS 合并合成 + 音频攒批（P0-3）
STT RTF 55 是瓶颈：paraformer 在 MPS 上慢 → 长句转写迟到 → 响应基于部分转写
  → 调 VAD 参数缓解 / 换更快的 STT（这是 F1 切换经历的核心素材）
```

---

## 本周动手任务（验收依据）

1. **复跑全链路**：装/启动 llama-server（或连 vLLM）+ speech-to-speech serve + 前端 demo
2. **记录数据**：TTFA / TTS RTF / STT RTF / LLM 延迟，填进上面的表（用你自己的机器）
3. **产出命令速查卡**（interview-prep 输出物清单第 3 项）：启动命令 + 参数 + ModelScope 下载命令
4. **测试脚本**：保留下 WebSocket 测试脚本（模拟音频输入，验证全链路）

---

*W5 讲义完 · 下一篇：W6 项目细节与模拟面试*
