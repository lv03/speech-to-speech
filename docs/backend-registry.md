# 后端注册表与启动流程详解

> 对应源码：`src/speech_to_speech/backend_registry.py`、`s2s_pipeline.py`、`cli.py`、
> `arguments_classes/`。
> 配套概念：[架构与链路](architecture.md) §5/§8、[pipeline 基础设施](pipeline-infra.md)。

---

## 1. 总览

后端注册表是"可插拔架构"的落地机制：每个 STT/LLM/TTS 后端被描述为一个 `BackendSpec`
（静态元数据 + 工厂函数），CLI/JSON 选择后由 `parse_arguments` 构建配置、
`create_backend_handler` 实例化。**加一个新后端 = 注册一个 BackendSpec**，无需改动管线代码。

```
arguments_classes/  参数 dataclass (每个后端一个)
      │  spec.normalize(config)
      ▼
BackendSelection(spec, config)   ← 注册表选择结果
      │  create_backend_handler(selection, HandlerContext)
      ▼
Handler 实例 (挂到 pipeline 的链上)
```

---

## 2. 核心类型（backend_registry.py）

### 2.1 BackendSpec（静态元数据）

| 字段 | 含义 |
|---|---|
| `name` | 唯一名称（CLI 的 `--stt`/`--llm_backend`/`--tts` 值） |
| `kind` | `"stt"` / `"llm"` / `"tts"`（注册时强校验） |
| `config_type` | 参数 dataclass（`arguments_classes/`） |
| `create_handler` | 工厂：`(HandlerContext, config: Mapping) -> Handler` |
| `config_prefix` | 参数前缀（如 `qwen3_tts` → `--qwen3_tts_*`） |
| `normalize_config` | 配置规范化回调（默认 `normalize_dataclass_config`） |
| `required_extra` | 可选依赖 extra（缺失时给出可操作的安装提示） |
| `capabilities` | `BackendCapabilities` 能力标记 |

### 2.2 BackendCapabilities（能力标记，驱动阶段组合）

| 标记 | 设置的后端 | 影响 |
|---|---|---|
| `bypasses_transcription_notifier=True` | `stt=none` | 跳过 TranscriptionNotifier，STT 直连 text_prompt_queue |
| `supports_audio_input=True` | `chat-completions` | 允许 `--stt none`（音频直接进 LLM） |
| `supports_llm_proxy=True` | `responses-api` / `chat-completions` | 允许 `--enable_llm_proxy` |

### 2.3 BackendSelection（选择结果）

```python
@dataclass(frozen=True)
class BackendSelection:
    spec: BackendSpec
    config: BackendConfig        # normalize 后的 handler kwargs
    def copy_for_pipeline(self) -> BackendSelection:  # deepcopy 配置
```

`copy_for_pipeline` 关键：**每个 PipelineUnit 拿到独立配置副本**，防止 setup 时的
可变状态（如 `gen_kwargs` dict）跨单元泄漏（对应 #373/#374 修复）。

### 2.4 normalize_dataclass_config（配置规范化）

把参数 dataclass 转成 handler 的 setup kwargs：

```
1. 去掉 config_prefix 前缀 (如 "qwen3_tts_speaker" → "speaker")
2. 收集 gen_ 前缀字段 + gen_kwargs → 合并为单一 "gen_kwargs" dict
3. deepcopy 防共享可变默认值
```

特殊用例：`_normalize_facebook_mms_config` 把 `tts_language` 重命名为 `language`。

---

## 3. 工厂函数族

| 工厂 | 用途 | 特点 |
|---|---|---|
| `_simple_handler_factory(module, class, ...)` | 通用后端 | `setup_should_listen`：把 `should_listen` 传为 setup_args；`context_kwargs`：注入 `cancel_scope` + `speculative_turns`；`attach_speculative_turns`：直接挂属性 |
| `_create_local_llm("transformers"/"mlx-lm")` | 本地 LLM | `is_vlm` 字段选 `VisionLanguageModelHandler`；mlx-lm 设 `backend="mlx"`；注入 cancel_scope/speculative_turns |
| `_create_parakeet` | Parakeet STT | 额外注入 `enable_live_transcription` / `live_transcription_update_interval`（来自 HandlerContext） |
| `_create_audio_input` | `stt=none` | `AudioInputNotifier`（直连音频输入） |

`_load_handler(module, class)`：延迟 import，`RuntimeError`（原生依赖缺失）转
`ImportError`。`create_backend_handler`：捕获 ImportError 并附
`required_extra` 安装提示（`pip install "speech-to-speech[extra]"`）。

**HandlerContext**（构造时传给每个工厂）：

```python
stop_event / queue_in / queue_out / text_output_queue / should_listen /
cancel_scope / speculative_turns / pipeline_index / sample_rate /
enable_live_transcription / live_transcription_update_interval
```

---

## 4. 注册表内容（当前后端矩阵）

### 4.1 STT_BACKENDS

| name | 参数类 | 工厂 | prefix | extra | capabilities |
|---|---|---|---|---|---|
| `none` | Empty | `_create_audio_input` | — | — | bypasses_notifier |
| `whisper` | WhisperSTTHandlerArguments | simple | stt | — | |
| `whisper-mlx` | Lightning...Args | simple | stt | whisper-mlx | |
| `mlx-audio-whisper` | MLXAudioWhisper...Args | simple | mlx_audio_whisper | — | |
| `faster-whisper` | FasterWhisper...Args | simple | faster_whisper_stt | faster-whisper | |
| `parakeet-tdt` | ParakeetTDT...Args | `_create_parakeet` | parakeet_tdt | — | |
| `paraformer` | Paraformer...Args | simple | paraformer_stt | paraformer | |

### 4.2 LLM_BACKENDS

| name | 参数类 | 工厂 | prefix | extra | capabilities |
|---|---|---|---|---|---|
| `transformers` | LanguageModelHandlerArguments | `_create_local_llm("transformers")` | llm | — | |
| `mlx-lm` | LanguageModelHandlerArguments | `_create_local_llm("mlx-lm")` | llm | mlx-lm | |
| `responses-api` | ResponsesApi...Args | simple (context_kwargs) | responses_api | — | supports_llm_proxy |
| `chat-completions` | ChatCompletions...Args | simple (context_kwargs) | responses_api | — | supports_audio_input + supports_llm_proxy |

### 4.3 TTS_BACKENDS

| name | 参数类 | 工厂 | prefix | extra |
|---|---|---|---|---|
| `chatTTS` | ChatTTS...Args | simple (setup_should_listen + context_kwargs) | chat_tts | chattts |
| `facebookMMS` | FacebookMMS...Args | simple (同左) + normalize 特例 | facebook_mms | — |
| `pocket` | PocketTTS...Args | simple (同左) | pocket_tts | pocket |
| `kokoro` | KokoroTTS...Args | simple (同左) | kokoro | kokoro |
| `qwen3` | Qwen3TTS...Args | simple (同左) | qwen3_tts | — |

---

## 5. 参数解析（s2s_pipeline.parse_arguments）

### 5.1 流程

```
1. 预解析: 只读 --stt/--llm_backend/--tts/--mac-optimal-settings (或 JSON 文件头)
   └─ 确定三个 BackendSelection (注册表查名, 未知名报错列选择)
2. 构建参数类集合:
   [ModuleArguments, RealtimeServerArguments(或 Local), LocalAudioArguments(local 模式),
    VADHandlerArguments, *已选后端的 config_type]
3. HfArgumentParser 解析 (CLI 或 JSON dict)
4. 未选后端的遗留参数: 兼容性 parser 接受但告警忽略
5. 组装 ParsedArguments (module_kwargs + 三个 BackendSelection)
```

### 5.2 关键策略

- **只解析已选后端**：`--stt parakeet-tdt -h` 只显示 Parakeet 的参数（可发现性）。
- **遗留参数兼容**：切换后端后旧的 `--whisper_*` 参数仍被接受，告警忽略
  （`_parse_selected_cli_configs` 双 parser 技巧）。
- **`--mac-optimal-settings`**：一键套用 Apple Silicon 最优组合
  （parakeet-tdt + mlx-lm + qwen3 + mps + MLX 默认模型），显式参数仍可覆盖
  （`_mac_preset_defaults` 只设 parser 默认值）。
- **JSON 配置**：单文件路径参数 → `parse_dict(allow_extra_keys=True)`（额外键忽略）。
- **`prepare_all_args`**：全局 `--device` 应用到已选后端的 config（未选不动）。

### 5.3 约束校验（prepare_module_args）

- `--stt none` 要求 LLM 支持 `supports_audio_input`。
- `--enable_llm_proxy` 要求 LLM 支持 `supports_llm_proxy`（否则列出可选后端报错）。
- macOS：`--device cuda` 拒绝；非 mlx-lm / 非 qwen3 组合给推荐告警。
- `num_pipelines < 1` 拒绝。
- Apple Silicon 多单元池自动禁用 live transcription（MLX 锁竞争）。

---

## 6. 启动流程（cli.py / run_pipeline_command）

### 6.1 两种运行模式

| 命令 | 组成 |
|---|---|
| `speech-to-speech serve` | 仅 RealtimeServer（`ws://host:port/v1/realtime`） |
| `speech-to-speech local` | serve 的 server + `RealtimeAudioClient`（回环 ws://127.0.0.1） |

### 6.2 启动时序

```
1. parse_arguments → ParsedArguments
2. setup_logger (PipelineLogFilter 挂到所有 handler)
3. prepare_all_args (device 应用 + 校验)
4. 多单元池的 MLX live-transcription 降级处理
5. _build_pipeline_unit × num_pipelines:
     deepcopy 配置 → 建队列/Event/CancelScope/SpeculativeTurnTracker
     → RealtimeService(每单元独立 Chat)
     → _build_handlers: VAD → [STT(+Notifier)] → LLM → LMOutputProcessor → TTS
     → PipelineUnit
6. RealtimeServer(池) → (local 模式 + RealtimeAudioClient)
7. ThreadManager(handlers + server) → 注册 SIGINT/SIGTERM
8. start() → wait()
```

### 6.3 优雅关闭

```
信号 → thread_manager.stop():
  stop_event.set()          # 所有 handler 循环退出
  → 链尾注入 PIPELINE_END 传播 → 各线程按序退出
  → join 5s 超时告警
uvicorn server: _watch_stop 线程等 stop_event → server.should_exit = True
```

### 6.4 日志上下文

`pipeline_log_ctx.set(index)`：每个 handler 线程和 send loop 都设置自己的
`pipeline_index`，日志自动带 `[Pipeline N]` 前缀——多单元池可区分。

---

## 7. 扩展指南：如何加一个新后端

以社区 PR（Qwen3-ASR / SenseVoice）为例：

```
1. arguments_classes/ 新建 xxx_arguments.py: 参数 dataclass (HfArgumentParser 兼容)
2. STT|LLM|TTS/ 新建 xxx_handler.py: 继承对应基类 (BaseSTTHandler 等)
3. backend_registry.py 对应 registry 追加 BackendSpec:
     BackendSpec("xxx", "stt", XxxSTTHandlerArguments,
                 _simple_handler_factory("speech_to_speech.STT.xxx_handler",
                                          "XxxSTTHandler",
                                          attach_speculative_turns=True),
                 config_prefix="xxx", required_extra="xxx")
4. 需要能力标记时设 capabilities (如 supports_audio_input)
5. pyproject.toml 加 extra; README 支持矩阵加行
```

**选择工厂形态**：

- 无特殊需求 → `_simple_handler_factory`（配 `setup_should_listen` / `context_kwargs` /
  `attach_speculative_turns`）。
- 需要 pipeline 上下文注入（如 Parakeet 的 live transcription）→ 自定义工厂。
- 需要音频直入 → 走 `AudioInputNotifier` 或 `bypasses_transcription_notifier`。

**校验清单**（注册时 `build_backend_registry` 自动做）：

- kind 匹配、名称唯一（重复/错类直接 ValueError）。
- `select_backend` 未知名给出可选列表。
- `create_backend_handler` 依赖缺失给出 `pip install "speech-to-speech[extra]"` 提示。

---

## 8. 设计要点总结

1. **注册表即文档**：所有后端及其参数前缀/能力/依赖一目了然，加后端不改管线代码。
2. **配置三阶段**：dataclass（参数）→ normalize（handler kwargs）→ deepcopy（单元隔离）。
3. **能力标记驱动组合**：bypasses_notifier / audio_input / llm_proxy 三个布尔决定
   管线拓扑，无需硬编码特判。
4. **依赖延迟报错**：import 失败才报，且提示具体安装命令。
5. **macOS 预设可覆盖**：默认值机制而非硬编码，保证显式参数优先。

---

*本文档随代码演进维护；如与源码行为不一致，以 `src/speech_to_speech/backend_registry.py` 与 `s2s_pipeline.py` 为准。*
