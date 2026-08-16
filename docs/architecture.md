# speech-to-speech 架构与链路详解

> 本文档基于 `huggingface/speech-to-speech` 源码（`src/speech_to_speech/`）梳理，描述项目
> 的整体架构、消息级数据流、线程模型与关键机制。适用于新贡献者快速理解代码库，
> 也作为实时层（OpenAI Realtime API 兼容）与多后端系统的设计参考。

---

## 1. 项目概览

一句话：**一个多后端可插拔的本地实时语音对话引擎**。四段线程化管线（VAD → STT → LLM → TTS）
之上，套了一层 OpenAI Realtime 协议兼容层（含 LLM 代理与 WebRTC 传输）。

核心设计目标：

- **每一阶段可插拔**：STT / LLM / TTS 均有多种后端，通过 CLI 选择（`--stt` / `--llm_backend` / `--tts`）。
- **每一阶段独立线程**：通过线程安全 `queue.Queue` 连接，天然支持流水线并行。
- **标准协议接入**：对外暴露 OpenAI Realtime API 兼容端点，标准客户端（如 OpenAI 官方 SDK）即可接入。
- **可离线运行**：支持全本地模型（llama.cpp、mlx-lm、Silero VAD 等），详见 README「Offline Operation」。

代码规模约 17k 行 Python（`src/speech_to_speech/`），核心模块：

| 模块 | 职责 |
|---|---|
| `s2s_pipeline.py` | 组装管线：参数解析、handler 链构建、PipelineUnit 池、运行入口（详见 [backend-registry.md](backend-registry.md)） |
| `backend_registry.py` | 后端注册表：`STT_BACKENDS` / `LLM_BACKENDS` / `TTS_BACKENDS`（详见 [backend-registry.md](backend-registry.md)） |
| `baseHandler.py` | 所有管线阶段的线程基类（run 循环、控制消息、哨兵处理）（详见 [pipeline-infra.md](pipeline-infra.md)） |
| `pipeline/` | 类型化消息、事件、控制消息、队列负载、取消作用域、推测性回合（详见 [pipeline-infra.md](pipeline-infra.md)） |
| `LLM/` | 语言模型后端、`Chat` 对话历史、输出处理器、工具调用（详见 [LLM 模块详解](llm.md)） |
| `STT/` | 语音转写后端、渐进式流式转写、转写通知器（详见 [STT 模块详解](stt.md)） |
| `TTS/` | 语音合成后端（详见 [TTS 模块详解](tts.md)） |
| `VAD/` | 语音活动检测（Silero VAD v5）、智能回合终结（详见 [VAD 模块详解](vad.md)） |
| `security/` | 安全门卫（唤醒词 + 声纹，可选，插在 VAD 之前）（详见 [security/README.md](../src/speech_to_speech/security/README.md)） |
| `api/openai_realtime/` | OpenAI Realtime API 兼容层（服务、路由、传输、代理、客户端）（详见 [realtime-api.md](realtime-api.md)） |
| `utils/` | 线程管理、MLX 全局锁、日志上下文 |

---

## 2. 总体架构：四段式级联管线

```
  用户音频 → [安全门卫(可选)] → [VAD] → [STT] → [LLM] → [TTS] → 合成音频 → 用户
              唤醒词+声纹       Silero    转写     生成      语音合成
              上锁时吞掉音频     VAD v5    文本     回复      并流式返回
```

每一阶段是一个 `BaseHandler` 子类，运行在**独立线程**中：

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  VADHandler  │ ──► │  STT handler │ ──► │  LLM handler │ ──► ...
│  (线程)       │     │  (线程)       │     │  (线程)       │
└──────────────┘     └──────────────┘     └──────────────┘
     队列              队列                 队列
```

线程模型通过 `ThreadManager`（`utils/thread_manager.py`）统一管理：

- 每个 handler 的 `run()` 循环以 0.1s 超时轮询输入队列，可随时响应 `stop_event`。
- 停止时向队列注入 `PIPELINE_END`（`b"END"`）哨兵，避免队列死锁。
- `SESSION_END` 为**软重置**控制消息：不停止线程，仅重置各 handler 的会话内状态。
- 所有 handler 共享 `pipeline_index` 日志上下文（`pipeline/log_context.py`）。

---

## 3. 数据流全链路（消息级）

### 3.1 完整链路

```
客户端 (WebSocket / WebRTC / 本地麦克风)
   │  音频字节流 (16kHz PCM16, 每块 512 样本 / 1024 字节)
   ▼
input_queue (AudioInItem = bytes | tuple[bytes, RuntimeConfig])
   │
   ▼
① VADHandler ──────────────── Silero VAD v5 检测语音边界
   │  输出 VADAudio(音频段, mode=progressive/final, turn_id, revision)
   │  · 智能回合结束 (SmartTurnAnalyzer 本地分类器)
   │  · 推测性回合跟踪 (speculative_turns)：打断/重开/未答回合
   ▼
② STT handler ─────────────── Parakeet/Whisper/Faster-Whisper/MLX/Paraformer...
   │  输出 PartialTranscription(部分转写, 实时字幕) / Transcription(最终转写)
   ▼
   TranscriptionNotifier (侧信道) ──► text_output_queue ──► 客户端转写事件
   │
   ▼
text_prompt_queue (GenerateResponseRequest: 携带 runtime_config + 会话 Chat)
   │
   ▼
③ LLM handler ─────────────── Transformers / mlx-lm / Responses-API / Chat-Completions
   │  流式输出 LLMResponseChunk(每句) / TokenUsage / EndOfResponse
   ▼
④ LMOutputProcessor ──────── 有序输出分流节点 (#453 重构)
   │  · parts 逐个 → AssistantOutputEvent（与音频同队列保序）
   │  · 文本 part → TTSInput（丢弃被取消/过期回合的输出）
   │  · TokenUsage → TokenUsageEvent（同队列，不再走侧信道）
   ▼
lm_processed_queue (事件 + TTS 输入混合, 保序)
   │
   ▼
⑤ TTS handler ────────────── Qwen3-TTS / Kokoro / PocketTTS / ChatTTS / MMS
   │  输出 AudioOutput(带 cancel_generation 标记)
   ▼
output_queue (send_audio_chunks_queue)
   │
   ▼
send loop (WebSocket router) → WebSocket/WebRTC transport → 客户端扬声器
   │
   └── AUDIO_RESPONSE_DONE 哨兵 → 触发 response.done / 解锁打断窗口
```

### 3.2 队列负载类型（`pipeline/queue_types.py`）

| 队列 | 负载类型 | 流向 |
|---|---|---|
| `input_queue` | `bytes` / `(bytes, RuntimeConfig)` | 传输层 → VAD |
| `spoken_prompt_queue` | `VADAudio` | VAD → STT |
| `stt_output_queue` | `PartialTranscription` / `Transcription` | STT → TranscriptionNotifier |
| `text_prompt_queue` | `GenerateResponseRequest` | Notifier/Service → LLM |
| `lm_response_queue` | `LLMResponseChunk`(有序 parts) / `TokenUsage` / `EndOfResponse` | LLM → LMOutputProcessor |
| `lm_processed_queue` | `AssistantOutputEvent` / `TTSInput` / `EndOfResponse`（#453：事件与 TTS 输入同队列保序） | LMOutputProcessor → TTS |
| `send_audio_chunks_queue` | 事件 + 音频块 + 哨兵（TTS 透传响应事件，#453） | TTS → send loop |
| `text_output_queue` | `PipelineEvent`（VAD/转写事件侧信道） | VAD/STT → Service → 客户端 |

所有队列负载统一基于 `PipelineMessage`（Pydantic 模型，`pipeline/messages.py`），
以 `tag` 字段作判别器；控制消息 `PipelineControlMessage` 与二进制哨兵（`PIPELINE_END`、
`AUDIO_RESPONSE_DONE`）也在这条链上流转。

### 3.3 消息关键字段

- `turn_id` / `turn_revision`：回合身份（配合 SpeculativeTurnTracker 判断输出是否过期）。
- `cancel_generation`：响应代数标签（配合 CancelScope 丢弃被打断的输出）。
- `runtime_config`：随请求流转的会话配置（`api/openai_realtime/runtime_config.py`）。
- `speech_stopped_at_s`：语音停止时间戳，用于延迟/竞态分析。

---

## 4. 线程模型：PipelineUnit 池

### 4.1 池结构

`num_pipelines`（默认 1）决定**并行 PipelineUnit 数量**。每个 unit（`pipeline_unit.py`）
拥有完全隔离的状态：

- 自己的 8 条队列（上表全部）
- `CancelScope`、`should_listen` / `response_playing` Event
- `SpeculativeTurnTracker`
- `RealtimeService`（含该单元独立的 `Chat` 对话历史）
- 整条 handler 链的**独立实例**（`_build_handlers` 对配置做 `deepcopy`，防止三方库
  在 setup 时的共享可变状态泄漏，对应 PR #373/#374 的修复）

`RealtimeServer`（uvicorn）持有池：

- 每个 WebSocket/WebRTC 连接在 accept 时**领取一个空闲 unit**（`unit.session is None`）。
- 池满则拒绝新连接。
- 连接断开后释放 unit，供下个会话复用。

### 4.2 会话生命周期（近期 PR 重点打磨的路径）

```
accept ──► 领取 unit ──► 创建 SessionState
   ...
断开 ──► _release_session:
   1. _clean_unit: cancel_scope.cancel() + 清空 4 条队列(保留哨兵) + reset
   2. 注入 SESSION_END(带 session_id) → 沿整条 handler 链传播
   3. 各 handler on_session_end() 重置状态 → 消息传回 output_queue
   4. send loop 观察到 SESSION_END → 置 session.drained
   5. _release_unit_after_drain: unregister 会话 → unit.session = None（释放）
```

异常路径：

- **drain 超时（10s）**：告警，unit 仍不可领取。
- **隔离（180s）**：`quarantined_at` 置位，立即 unregister 会话（关闭 Chat，
  防止迟到输出篡改/计费旧会话），unit **保持隔离不释放**，直到 SESSION_END 真正
  drain 才回到池中；`/v1/pool` 端点可查看 "stuck" 状态。
- 设计动机：已跑起来的 handler 可能产出不带会话身份的迟到输出（如转写），
  若释放给新会话会造成**跨会话泄漏**（对应 #455、#456 问题域）。

---

## 5. 后端注册表（`backend_registry.py`）

### 5.1 BackendSpec

每个后端 = `BackendSpec`：

- `name` / `kind`（stt/llm/tts）
- `config_type`：该后端的参数 dataclass（`arguments_classes/`）
- `create_handler`：工厂函数（接收 `HandlerContext` + 配置）
- `config_prefix`：参数前缀（如 LLM 的 `llm`）
- `normalize_config`：配置规范化（默认 `normalize_dataclass_config`）
- `required_extra`：需要的可选依赖 extra 名
- `capabilities: BackendCapabilities`：**能力标记，驱动阶段组合逻辑**

### 5.2 能力标记（BackendCapabilities）

| 标记 | 含义 | 影响 |
|---|---|---|
| `bypasses_transcription_notifier` | 后端自带音频输入通道（如 `stt=none`） | 跳过 TranscriptionNotifier 环节，STT 直连 text_prompt_queue |
| `supports_audio_input` | LLM 能直接吃音频（多模态） | 允许 `--stt none` |
| `supports_llm_proxy` | 支持被 LLM 代理转发 | 允许 `--enable_llm_proxy`（离线 llama.cpp 场景） |

### 5.3 当前后端矩阵

| 阶段 | 后端 | 说明 |
|---|---|---|
| VAD | Silero VAD v5 | 内置；可选 DeepFilterNet 音频增强、SmartTurn 回合分类器 |
| STT | `parakeet-tdt`（默认） | CUDA/CPU 走 nano-parakeet，Apple Silicon 走 MLX |
| STT | `whisper` | Transformers 实现 |
| STT | `faster-whisper` | SYSTRAN 实现 |
| STT | `lightning-whisper-mlx` | Apple Silicon |
| STT | `mlx-audio-whisper` | Apple Silicon（mlx-audio） |
| STT | `paraformer` | FunASR |
| STT | `none` | 跳过 STT，音频直接进多模态 LLM |
| LLM | `transformers` | 本地 Transformers 模型 |
| LLM | `mlx-lm` | Apple Silicon 默认 |
| LLM | `responses-api` / `chat-completions` | OpenAI 兼容 API（托管或自托管） |
| TTS | `qwen3`（默认） | Qwen3-TTS（GGML/CUDA/mlx-audio） |
| TTS | `kokoro` / `pocket` / `chatTTS` / `facebook-mms` | 各种开源 TTS |

> 社区 PR 正在扩展：SenseVoice（FunASR）、Qwen3-ASR、OpenAI 兼容 STT/TTS 端点、
> Qwen3-TTS 声音克隆等。

### 5.4 配置解析策略

`parse_arguments` 只解析**已选后端**的参数 dataclass；未选后端的遗留参数仍被接受
但告警忽略（`_parse_selected_cli_configs`）。支持 JSON 配置文件与
`--mac-optimal-settings` 一键套用 Apple Silicon 最优组合
（parakeet-tdt + mlx-lm + qwen3 + mps）。

---

## 6. 实时层：OpenAI Realtime API 兼容（`api/openai_realtime/`）

### 6.1 模块职责

| 模块 | 职责 |
|---|---|
| `server.py` | uvicorn 服务器；持有 PipelineUnit 池；停止信号联动 |
| `websocket_router.py` | FastAPI 路由 + 核心 send loop；客户端事件分发；barge-in flush；会话释放/隔离 |
| `service.py`（RealtimeService） | 协议状态机：解析客户端事件、维护会话状态与 Chat、生成服务端事件、UsageMetrics 计费 |
| `handlers/` | 四个协议域处理器：`audio` / `conversation` / `response` / `session` |
| `runtime_config.py` | 随请求流转的会话配置 |
| `transports.py` / `webrtc_session.py` | WebSocket 与 WebRTC 双传输抽象 |
| `llm_proxy.py` | 将 Realtime 协议转发到上游 OpenAI 兼容 LLM（无需本地模型） |
| `audio_client.py` | `local` 模式的回环客户端（麦克风 → ws → 扬声器） |

### 6.2 事件协议（标准 Realtime 事件）

**客户端 → 服务端**：

| 事件 | 处理 |
|---|---|
| `input_audio_buffer.append` | 仅 WebSocket；切块后写入 `unit.input_queue`（携带 runtime_config） |
| `input_audio_buffer.commit` | 触发 VAD 强制回合结束 |
| `output_audio_buffer.clear` | 仅 WebRTC；flush output_queue + transport 丢弃待播音频（对应 #455 bug 域） |
| `session.update` | 更新会话配置，回发 `session.updated` |
| `conversation.item.create` | 注入对话项（含工具执行结果） |
| `response.create` | 触发 LLM 生成；`unit.cancel_scope.new_response()` 开启新代数 |
| `response.cancel` | 取消当前生成 |

**服务端 → 客户端**：`session.created/updated`、`input_audio_buffer.speech_started/stopped`、
`conversation.item.created`、`response.created/done`、`response.audio.delta/done`、
`response.text.delta/done`、`response.function_call.arguments.done`、`error`。

### 6.3 传输差异

- **WebSocket**：音频走 `input_audio_buffer.append` 事件。
- **WebRTC**：音频走媒体轨道（SDP offer 领取 unit），`append` 事件被拒绝（
  `invalid_event_for_transport`）；`output_audio_buffer.clear` 仅 WebRTC 可用。

### 6.4 send loop 要点

- 从 `output_queue` 取块 → `_to_audio_bytes` → transport 发送。
- `AUDIO_RESPONSE_DONE` 哨兵触发 `response.done` 并清空 discard 窗口。
- barge-in 时 `_flush_queue(unit.output_queue, preserve=_keep_audio_sentinel)`：
  清空待播音频但**保留**响应完成哨兵与控制消息（否则释放路径会永远等待 drain）。
- **#453**：响应事件（AssistantOutputEvent/AssistantResponseDoneEvent/TokenUsageEvent）
  与音频同队列；send loop 按 `response_key` 丢弃已关闭响应的迟到输出
  （`_response_key_is_obsolete`）。text_output_queue 只余 VAD/转写事件。

---

## 7. 关键机制（近期修复热点）

### 7.1 取消作用域（`pipeline/cancel_scope.py`）

- 每次 `response.create` 递增 `generation`（代数）。
- 所有下游输出（TTS 音频、assistant 文本）打上 `cancel_generation` 标签。
- send loop 通过 `_generation_is_discardable` 判断：已过期的代数（`is_stale`）
  或 discard 窗口内的非当前代数 → 丢弃。
- 文本与音频两条路径共享该判断，避免打断时文本/音频不同步。

### 7.2 推测性回合（`pipeline/speculative_turns.py`）

解决"用户打断时 LLM 是否已开始生成"的竞态：

- 打断后短时间内（`speculative_reopen_ms`）到达的新转写视为对**旧回合的修正**
  （reopen），其 LLM 输出可能被丢弃。
- 超过 `unanswered_reopen_ms` 的未答回合才真正触发新一轮生成。
- `is_latest_after_reopen_grace` 供 LMOutputProcessor 过滤过期输出。

### 7.3 对话历史（`LLM/chat.py`）

`Chat` 类管理会话历史：

- 滑动窗口 + 最旧回合驱逐（`_evict_oldest_turn`）。
- 超长时压缩：`compaction`（摘要）worker，可替换为 LLM 压缩。
- **#453 事务化**：`add_provisional_generation_items` 原子写入 + 按 `response_key` 跟踪，
  `finalize_provisional_generation` 提交 / `rollback_provisional_generation` 打断时回滚。
- 可导出为 `to_responses_api_chat` / `to_transformers_chat` 两种格式。
- 音频历史条目支持 `compact_audio_history` 压缩与图像条目剥离。

### 7.4 工具调用闭环（#453 有序输出）

```
LLM 流式输出 (有序 parts) → LMOutputProcessor 逐个产出 AssistantOutputEvent
   → 与 TTSInput 同队列保序 → send loop → 客户端 response.function_call.arguments.done
客户端执行工具 → conversation.item.create(tool output)
   → service 写入 Chat（append_tool_output，provisional 事务跟踪）
   → 客户端 response.create → 新一轮生成（LLM 携带工具结果）
```

### 7.5 智能回合终结（VAD 层）

- Silero VAD v5 基础端点检测 + `SmartTurnAnalyzer`（本地分类器）判定句子是否完整。
- 短句拼接（`short_segment_merge_ms`）、未答回合重开、打断后 reopen 窗口。
- 对应 #433「可逆预确认音频 ducking」等延迟优化方向。

### 7.6 渐进式流式转写（`STT/smart_progressive_streaming.py`）

- 大模型音频输入按 `realtime_processing_pause` 间隔切块做**渐进式转写**（实时字幕）。
- 最终回合结束再跑一次完整转写（`final`）作为正式结果。
- Apple Silicon 上受 MLX 全局锁（`utils/mlx_lock.py`）竞争影响：
  `num_pipelines > 1` 时自动禁用实时转写以避免日志洪水。

---

## 8. 两种运行模式（`cli.py` / `s2s_pipeline.py`）

| 命令 | 行为 |
|---|---|
| `speech-to-speech serve` | 仅启动 Realtime API 服务器（`ws://host:port/v1/realtime`），供标准客户端连接 |
| `speech-to-speech local` | server + 回环音频客户端（麦克风输入/扬声器输出），单机对话 |

启动流程（`run_pipeline_command`）：

1. `parse_arguments` 解析参数（按后端选择器构建参数类集合）。
2. `prepare_all_args` 校验 + 全局 device 应用到已选后端。
3. 构建 PipelineUnit 池 → `RealtimeServer`（或 + `RealtimeAudioClient`）。
4. 注册 SIGINT/SIGTERM 优雅关闭 → `ThreadManager.start()` / `wait()`。

---

## 9. 关键设计原则与易错点

1. **队列哨兵纪律**：`PIPELINE_END` 是停止哨兵，`AUDIO_RESPONSE_DONE` 是响应完成
   哨兵，`SESSION_END` 是软重置控制消息——三者语义不同，flush 时注意保留规则。
2. **状态隔离**：多 PipelineUnit 之间必须完全隔离（队列/Handler/配置深拷贝），
   任何共享可变状态都会造成跨会话泄漏。
3. **取消必须带代数**：一切下游输出（音频/文本/计费）都应按 `cancel_generation`
   标记，否则打断后会产生"幽灵输出"。
4. **transport 语义差异**：WebSocket 与 WebRTC 对 append/clear 事件的合法性不同，
   分发时必须按 `transport_kind` 校验。
5. **macOS 特例**：MLX 全局锁、mps 设备、默认后端组合（parakeet/mlx-lm/qwen3）
   均有专门代码路径。
6. **会话生命周期是异步的**：释放（drain）在独立 asyncio task 中进行，unit 释放
   必须在 SESSION_END 确认传播完成后进行。

---

## 10. 近期活跃方向（2026-08）

| 方向 | 内容 | 对应 PR/Issue |
|---|---|---|
| 实时会话正确性 | 输出生命周期加固、转写事件语义、token 计费不丢失、音频 clear 重放 | #445 #442 #456 #455 #454 |
| STT 行为修复 | Whisper 回合终结、语言检测、faster-whisper 语言上报、配置泄漏 | #451 #378 #424 #405 #373 #374 |
| 新后端 | OpenAI 兼容 STT/TTS 端点、Qwen3-ASR、SenseVoice | #369 #382 #396 #319 |
| 离线可用性 | llama.cpp 推荐、Silero 离线缓存、离线文档 | #446 #448 |
| 依赖升级 | MLX 线程安全版本栈 | #450 |
| 新功能 | 声音克隆、可逆音频 ducking、填充语音、vision resolver | #371 #434 #383 #402 |

---

*本文档随代码演进维护；如与源码行为不一致，以 `src/speech_to_speech/` 为准。*
