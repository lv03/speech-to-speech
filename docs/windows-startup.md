# Windows 启动指南（CUDA）— 实测可用

> 本文档记录本项目在 **Windows + NVIDIA GPU（CUDA）** 下的**实测可运行**配置，
> 供 Windows 兼容开发使用。文末附与 macOS 的差异对照和踩坑记录。

---

## 0. 实测环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows（WDDM 驱动模式） |
| GPU | NVIDIA GeForce RTX 3050（**4GB 显存**，Ampere sm_86） |
| 驱动 | 581.29（`nvidia-smi` 显示 `CUDA Version: 13.0`） |
| Python | 3.10.11（venv 基于 `C:\Users\zyc\AppData\Local\Programs\Python\Python310`） |
| venv | `E:\ai voice assistant\.venv`（在项目**上一级**目录） |
| 项目 | fork `lv03/speech-to-speech`，分支 `desktop-gateway-knowledge` |

**实测结论**：全链路（VAD → STT → LLM → TTS）在 Windows + CUDA 上跑通。

---

## 1. 一键安装（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File "E:\ai voice assistant\speech-to-speech\scripts\setup-windows.ps1"
```

脚本做四件事：复用/创建 venv → 升级 pip → 安装项目（含 kokoro）→ **最后**强制装 CUDA 版 torch。

> ⚠️ 顺序很关键：必须**先装项目、最后装 CUDA torch**。
> 若反过来（先 torch 后项目），`pip install -e .` 会从 PyPI 拉一个更新的 **CPU 版 torch**
> 把 CUDA 版覆盖掉，导致 `torch.cuda.is_available() == False`。

---

## 2. 手动安装步骤（等价，便于排查）

```powershell
cd "E:\ai voice assistant\speech-to-speech"

# 1) venv（已存在则跳过）
python -m venv "E:\ai voice assistant\.venv"

$py  = "E:\ai voice assistant\.venv\Scripts\python.exe"
$pip = "E:\ai voice assistant\.venv\Scripts\pip.exe"

# 2) 升级 pip —— 必须！pip 23.0.x 有 wheel 元数据解析 bug
& $py -m pip install --upgrade pip

# 3) 安装项目（含轻量 TTS kokoro）
& $pip install -e ".[kokoro]"

# 4) 最后强制装 CUDA 版 torch（cu128 = torch 2.11.0 + torchaudio 2.11.0 配对）
& $pip install --force-reinstall torch torchaudio --index-url https://download.pytorch.org/whl/cu128

# 5) 校验（应为 True）
& $py -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

实测输出：`torch 2.11.0+cu128` / `cuda_available = True`。

若 cu128 不可用，脚本 `fix-torch.ps1` 会依次回退 `cu130 → cu126 → cu124`。

---

## 3. 启动

### 3.1 设置 API Key（cmd 语法！）

本项目 LLM 默认走 OpenAI 兼容接口，这里用 **DeepSeek**（`/chat/completions`）。

> ⚠️ 两个 cmd 陷阱（都踩过）：
> 1. **必须用引号包住赋值**：`set "VAR=值"`。若写成 `set VAR=值 && 命令`，
>    `&&` 前的空格会被算进变量值，key 变 `sk-xxx `（带尾空格），导致
>    `Illegal header value b'Bearer sk-xxx '`。
> 2. `$env:VAR = "..."` 是 **PowerShell** 语法，在 **cmd** 里无效，cmd 要用 `set`。

```cmd
set "OPENAI_API_KEY=sk-你的DeepSeekKey"
```

### 3.2 启动服务

```cmd
powershell -ExecutionPolicy Bypass -File "E:\ai voice assistant\speech-to-speech\scripts\start-windows.ps1"
```

等价于：

```powershell
speech-to-speech serve `
  --tts kokoro `
  --llm_backend chat-completions `
  --model_name deepseek-chat `
  --responses_api_base_url https://api.deepseek.com `
  --responses_api_reasoning_effort= `
  --responses_api_disable_thinking false
```

### 3.3 实际对话（麦克风 + 扬声器）

```cmd
powershell -ExecutionPolicy Bypass -File "E:\ai voice assistant\speech-to-speech\scripts\start-windows.ps1" -Local
```

`-Local` 会把 `serve` 换成 `local`（服务 + 麦克风/扬声器一体）。

### 3.4 启动成功标志

```
nano-parakeet model loaded successfully on cuda      <- STT 上 CUDA
KokoroTTSHandler warmed up                           <- TTS 就绪
ChatCompletionsApiModelHandler:  warmed up!          <- LLM(DeepSeek) 连通
Uvicorn running on http://127.0.0.1:8765             <- 服务起来
```

---

## 4. 为什么用这套配置

| 项 | 值 | 原因 |
|---|---|---|
| `--tts` | `kokoro` | RTX 3050 只有 4GB 显存；Qwen3-TTS(1.7B) 权重就 ~3.4GB，和 STT 同驻会 OOM |
| `--llm_backend` | `chat-completions` | DeepSeek 只支持 `/chat/completions`，不支持 OpenAI 的 `/responses` |
| `--model_name` | `deepseek-chat` | DeepSeek-V3，延迟低；`deepseek-reasoner` 会明显变慢 |
| `--responses_api_reasoning_effort=` | 空 | 避免把 OpenAI 专属 `reasoning_effort` 发给 DeepSeek |
| `--responses_api_disable_thinking false` | | 避免发送 vLLM/Qwen 专属 `chat_template_kwargs` |
| torch 源 | `cu128` | torch 2.11.0 与 torchaudio 2.11.0 版本配对（cu130/cu126 上是 2.14.0/2.11.0 不配对） |

---

## 5. 踩坑记录（按遇到顺序）

| 现象 | 根因 | 解决 |
|---|---|---|
| PowerShell 脚本报 `} else {` 意外标记、`&` 不允许 | `.ps1` 内含中文，Windows PowerShell 5.1 用 ANSI 解码 UTF-8 无 BOM 文件 → 解析错乱 | 脚本只用 ASCII（英文） |
| `openai.OpenAIError: The api_key ... must be set` | 默认 `responses-api` 后端**启动时**就构造 OpenAI 客户端，强制要 key | 提供 key，或换本地 LLM |
| `torch 2.14.0+cpu / cuda_available False` | 先装 torch 后装项目，CPU torch 覆盖了 CUDA torch | 改成**最后**装 CUDA torch（`fix-torch.ps1`） |
| `Could not find a version that satisfies flit_core<4,>=3.11` | pip 23.0.1 误判 wheel 元数据名不一致 → 丢弃 wheel 回退编译源码 → 缺构建依赖 | 先 `python -m pip install --upgrade pip` |
| `expected one argument`（`--responses_api_reasoning_effort`） | PowerShell 5.1 把空字符串参数丢弃 | 用 `--responses_api_reasoning_effort=`（等号紧跟空值） |
| `Illegal header value b'Bearer sk-xxx '` | cmd `set VAR=值 && ...` 把空格计入变量值 | 用 `set "VAR=值"` |
| `$env:...` 报"文件名、目录名或卷标语法不正确" | 在 **cmd** 里用了 PowerShell 语法 | cmd 用 `set`，或先 `powershell` 进 PS |

### 无害警告（可忽略）

- `DeepFilterNet not available ... No module named 'df'` —— 可选音频增强，未装
- `unauthenticated requests to the HF Hub` —— 仅限速提示
- `huggingface_hub cache-system uses symlinks ...` —— Windows 未开开发者模式的缓存降级提示
- `RNN module weights are not part of single contiguous chunk` —— cuDNN LSTM 提示
- `SaT sentence segmenter unavailable ... falling back to nltk` —— 未装 `[sat]`，
  分句回退到 nltk（**英文分句**）；若要中文分句需 `pip install -e ".[sat]"`

---

## 6. 与 macOS 协作者对齐

| 维度 | macOS（Apple Silicon） | Windows（CUDA） |
|---|---|---|
| 一键预设 | `--mac-optimal-settings` | 无，需显式传 Windows 参数 |
| STT | parakeet-tdt（mlx） | parakeet-tdt（nano-parakeet，自动 cuda） |
| LLM 本地 | `--llm_backend mlx-lm` | `--llm_backend transformers`（或自建服务器） |
| TTS | qwen3（mlx-audio，6bit） | qwen3（faster-qwen3-tts，**torch** 后端）或 kokoro |
| TTS 后端参数 | `--qwen3_tts_mlx_quantization` | `--qwen3_tts_backend torch` |
| 依赖来源 | mlx / mlx-audio / mlx-lm | torch（CUDA wheel）+ transformers |

**约定**：
- Mac 侧 `--mac-optimal-settings` 是 Mac 专属；
- Windows 侧用 qwen3 时必须加 `--qwen3_tts_backend torch`（ggml 是 Linux 专属），
  4GB 显存机器优先 `--tts kokoro`；
- 共用的 `--stt` / `--llm_backend` / `--tts` / `--model_name` 保持正交，可自由组合。

---

## 7. 相关脚本

| 脚本 | 作用 |
|---|---|
| `scripts/setup-windows.ps1` | 一键安装（venv → pip 升级 → 项目 → CUDA torch） |
| `scripts/fix-torch.ps1` | 单独修复/切换 CUDA torch（自动试 cu128/cu130/cu126/cu124） |
| `scripts/start-windows.ps1` | 启动（默认 DeepSeek + kokoro；`-Local` 走麦克风） |
