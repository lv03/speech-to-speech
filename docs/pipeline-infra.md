# 管线基础设施详解（pipeline/ + baseHandler + utils）

> 对应源码：`src/speech_to_speech/pipeline/`（messages.py / events.py / control.py /
> queue_types.py / handler_types.py / cancel_scope.py / speculative_turns.py /
> log_context.py）、`baseHandler.py`、`utils/`（thread_manager.py / mlx_lock.py）。
> 配套概念：[架构与链路](architecture.md) §2/§3/§7、[实时层](realtime-api.md)。

---

## 1. 总览

这是整个引擎的"神经系统"：类型化消息、事件侧信道、控制消息、哨兵、取消作用域、
推测性回合跟踪、线程基类与线程管理。四大管线模块（VAD/STT/LLM/TTS）都建立在这套
基础设施之上。

```
messages.py     类型化负载 (PipelineMessage)        → 走 8 条队列
events.py       侧信道事件 (PipelineEvent)          → 走 text_output_queue
control.py      控制消息 (SESSION_END)              → 混入任意队列
cancel_scope.py 代数取消信号                         → 全局共享 (每 unit 一个)
speculative_turns.py 回合修订跟踪                    → 全局共享
baseHandler.py  线程基类                            → 所有 handler 继承
thread_manager  线程生命周期                        → ThreadManager
mlx_lock        全局 MLX 锁                         → Apple Silicon 并发安全
log_context     日志上下文 (pipeline_index)          → 多会话日志区分
```

---

## 2. 消息体系（messages.py）

### 2.1 PipelineMessage 基类

所有队列负载继承 `PipelineMessage`（Pydantic BaseModel），`tag` 字段作判别器，
可从原始 dict 反序列化。`ConfigDict(arbitrary_types_allowed=True)` 允许携带
`np.ndarray`、`RuntimeConfig` 等非 Pydantic 对象。

### 2.2 全消息清单

| 消息 | tag | 流向 | 关键字段 |
|---|---|---|---|
| `VADAudio` | `vad_audio` | VAD → STT | `audio`(ndarray)、`mode`(progressive/final)、`turn_id`、`turn_revision`、`processing_delay_s`、`created_at_s` |
| `PartialTranscription` | `partial_transcription` | STT → Notifier | `text`、turn 元数据 |
| `Transcription` | `transcription` | STT → Notifier | `text`、`language_code`、`speech_stopped_at_s` |
| `LLMResponseChunk` | `llm_response_chunk` | LLM → LMOutputProcessor | `text`、`tools`(list)、`runtime_config`、`response`、`cancel_generation` |
| `TokenUsage` | `token_usage` | LLM → LMOutputProcessor | `input_tokens`、`output_tokens` |
| `EndOfResponse` | `end_of_response` | LLM → ... → TTS | `error`(失败原因，无 error 时正常结束) |
| `TTSInput` | `tts_input` | LMOutputProcessor → TTS | `text`、`language_code`、`response` |
| `AudioOutput` | `audio_output` | TTS → send loop | `audio`(bytes/ndarray)、`cancel_generation` |
| `GenerateResponseRequest` | `generate_response` | Service → LLM | `runtime_config`(含 Chat!)、`response`(每响应覆盖)、`audio`(stt=none)、`language_code`、turn 元数据 |

### 2.3 哨兵（二进制常量，走音频/输出队列）

| 哨兵 | 值 | 语义 |
|---|---|---|
| `PIPELINE_END` | `b"END"` | **停止**哨兵：handler 收到即退出线程（配合 stop_event 防队列死锁） |
| `AUDIO_RESPONSE_DONE` | `b"__RESPONSE_DONE__"` | **响应完成**：send loop 据此发 `response.done`、解锁打断窗口 |

> ⚠️ 哨兵纪律（architecture §9.1）：`PIPELINE_END` 停止线程；`AUDIO_RESPONSE_DONE`
> 结束响应；`SESSION_END` 软重置会话。三者语义不同，flush 队列时保留规则各异
> （见[实时层](realtime-api.md) §5.2 的 `_keep_audio_sentinel`）。

---

## 3. 事件侧信道（events.py）

`PipelineEvent`（`type` 字段判别器）走 `text_output_queue`，由 send loop 消费并转成
Realtime 协议事件。**与消息的区别**：消息是链内逐级传递的"工作负载"，事件是
**跨级直达客户端的"通知"**（不经过中间 handler）。

| 事件 | 产生者 | 消费方 |
|---|---|---|
| `SpeechStartedEvent` | VAD | → `speech_started` + 打断逻辑（`interrupt_response` 字段控制） |
| `SpeechStoppedEvent` | VAD | → `speech_stopped` |
| `PartialTranscriptionEvent` | TranscriptionNotifier | → `transcription.delta` |
| `TranscriptionCompletedEvent` | TranscriptionNotifier | → `transcription.completed` + 触发 LLM |
| `AudioInputCompletedEvent` | AudioInputNotifier | stt=none 音频输入完成 → 触发 LLM |
| `AssistantTextEvent` | LMOutputProcessor | → `response.text.delta` / `function_call.arguments.done`（带 `cancel_generation`） |
| `TokenUsageEvent` | LMOutputProcessor | 计费累积 |
| `ResponseFailedEvent` | LMOutputProcessor | → `response.done(status="failed")` |

---

## 4. 控制消息（control.py）

```python
class PipelineControlMessage:   # frozen dataclass
    kind: ControlKind           # 目前只有 SESSION_END
    session_id: str | None      # 来源会话标记（防跨会话误判 drain）

SESSION_END = PipelineControlMessage(ControlKind.SESSION_END)
```

**SESSION_END 语义**：软重置。`BaseHandler.run()` 收到后调用 `on_session_end()`
（各 handler 重置会话内状态：缓冲、计数器、voice、语言等），然后**透传到输出队列**
继续沿链传播——最终回到 output_queue 时，send loop 置 `session.drained`，
释放路径才允许 unit 回到池中。

`session_id` 标记：被强制释放的会话其迟到的 SESSION_END 不会满足下个会话的 drain 等待。

---

## 5. BaseHandler — 线程基类

### 5.1 run 循环

```
while not stop_event.is_set():
    item = queue_in.get(timeout=0.1)      # 0.1s 超时 → 周期性检查 stop
    ├─ SESSION_END → on_session_end() → 透传 queue_out
    ├─ PIPELINE_END (bytes) → break
    ├─ 其他控制消息 → 告警跳过
    └─ 正常负载 → process(item) → yield 逐个出队
         ├─ should_process_input 过滤 (取消/过期)
         ├─ 计时 (last_time, 日志阈值)
         ├─ should_emit_output 过滤 (输出侧过期)
         ├─ before_emit_output (副作用, 如 STT 标记已完成 final)
         └─ output_for_queue (给输出打 cancel_generation 标签 → AudioOutput)
cleanup() → queue_out.put(PIPELINE_END)   # 链上后续 handler 依次退出
```

### 5.2 钩子速查

| 钩子 | 默认行为 | 用途示例 |
|---|---|---|
| `setup(*args, **kwargs)` | no-op | 加载模型、初始化状态（`setup_args`/`setup_kwargs` 传入） |
| `process(input)` | 抛 NotImplementedError | 核心处理，yield 输出 |
| `should_process_input(item)` | cancel_scope 过期检查 | STT 的回合过滤（[stt.md](stt.md) §2） |
| `should_emit_output(output)` | True | STT 输出侧过滤 |
| `before_emit_output(output)` | no-op | STT 标记 completed final revision |
| `output_for_queue(output, input)` | 无 cancel_generation 则原样 | 打代数标签 → `AudioOutput` |
| `on_session_end()` | no-op | 会话软重置 |
| `cleanup()` | no-op | 释放模型资源 |
| `should_log_timing` / `timing_log_level` | 阈值 1ms / DEBUG | 计时日志策略 |

---

## 6. CancelScope — 代数取消（cancel_scope.py）

**思想**：不用"脉冲式"布尔信号（易竞态），用**单调递增的代数计数器**。

```
generation: int       # 当前代数 (每次 cancel 递增, 0xFFFFFFFF 回绕)
discarding: bool      # 取消后的丢弃窗口 (send loop 用)
discarded_generation  # 被取消的那一代 (response_done 收尾判定用)
```

| 方法 | 调用方 | 行为 |
|---|---|---|
| `cancel()` | send loop（打断/response.cancel/会话释放） | `discarded_generation=gen`、`gen+=1`、`discarding=True` |
| `response_done(gen)` | send loop（AUDIO_RESPONSE_DONE） | 校验代数后清除丢弃窗口 |
| `new_response()` | response.create | 清除丢弃窗口（显式新响应） |
| `is_stale(gen)` | LLM/TTS 线程（每 token/每块） | `gen != 当前代数` → 过期 |
| `discarding` | send loop | 丢弃窗口期间非当前代数输出全部丢弃 |
| `reset()` | 会话接管前 `_clean_unit` | 清状态 |

**线程安全**：单写者（asyncio 路由线程）+ 多读者（handler 线程），GIL 使 int/bool
读写原子，无需锁。

**与输出标记的关系**：LLM/TTS 开始生成时捕获 `generation`，输出打 `cancel_generation`
标签；send loop 的 `_generation_is_discardable` = `is_stale(gen)` 或
`discarding 且 gen != 当前`。文本与音频共享该判定（防止打断时文本/音频不同步）。

---

## 7. SpeculativeTurnTracker — 推测性回合（speculative_turns.py）

线程安全（`Condition`）的回合修订跟踪器。核心概念：

- **turn_id**：一个用户语音回合（`turn_1`, `turn_2`...）。
- **revision**：回合被"重开"（用户补充说话）时递增。
- **commit**：回合定稿（TTS 开始合成时），之后不再接受重开。
- **reopen grace**：语音软结束后的宽限期，期间重开允许。
- **pending reopen candidate**：语音重新开始但未确认时登记的候选。

### 7.1 公开 API 分组

| 分组 | 方法 | 语义 |
|---|---|---|
| 观察 | `observe(turn, rev)` | 登记新 revision（VAD 每次分配调用） |
| 最新检查 | `is_latest(turn, rev)` | 是否当前最新 revision |
| 阻塞最新 | `is_latest_after_pending_reopen` / `is_latest_after_reopen_grace` | 等 pending 落定 / 等宽限结束再判断 |
| 非阻塞最新 | `try_is_latest_after_*` | 未决时返回 `None`（调用方重试） |
| 提交 | `commit(turn, rev)` / `commit_if_latest_after_*` / `try_commit_if_latest_after_*` | 定稿回合 |
| 状态查询 | `has_pending_reopen` / `has_pending_reopen_or_grace` / `is_committed` | service 决定是否 defer 事件 |
| 宽限 | `start_reopen_grace(turn, rev, grace_s)` | VAD 软结束后开启宽限 |
| 稳定窗口 | `is_latest_after_stability_window(turn, rev, settle_s)` | STT final 块等待静置期 |
| 重开登记 | `begin_reopen_candidate` / `confirm_reopen_candidate` / `cancel_reopen_candidate` | VAD 三段式重开 |
| 重置 | `reset()` | 会话开始/结束 |

### 7.2 阻塞 vs 非阻塞（重要约定）

| | 阻塞族 | 非阻塞族 (try_) |
|---|---|---|
| pending 未决时 | 等待最多 2s（`_PENDING_REOPEN_WAIT_TIMEOUT_S`） | 返回 `None` |
| 宽限未过时 | 等待 | 返回 `None` |
| 用途 | handler 线程（STT/LLM/TTS 可阻塞） | send loop（asyncio 不能阻塞） |

### 7.3 生命周期时序

```
VAD 软结束 (yield final) ──► start_reopen_grace(800ms/2000ms)
   │
   ├─ 用户继续说话 (gap ≤ 宽限):
   │    begin_reopen_candidate → 语音确认有效 → confirm → revision+1
   │    → 旧 revision 的所有下游输出 (STT/LLM/TTS) 因 is_latest 失败被丢弃
   │
   └─ 无重开:
        TTS 开始合成 → commit → 回合锁定
        (commit_if_latest_after_reopen_grace 保证宽限后才提交)
```

---

## 8. ThreadManager / MLX 锁 / 日志上下文（utils/）

### 8.1 ThreadManager（thread_manager.py）

```
start(): 每个 handler 起一个非 daemon 线程 (handler.run)
wait():   join 全部
stop():   stop_event.set() → join 5s 超时 → 告警未退出线程
```

`PIPELINE_END` 哨兵 + stop_event 双保险：线程按序退出（链尾 handler 收到前驱的
PIPELINE_END 后 break）。

### 8.2 MLXLockContext（mlx_lock.py）

Apple Silicon 上 MLX 推理共享**单一 Metal 命令队列**，并发调用会崩进程
（"Completed handler provided after commit call"）。所有 MLX 路径（STT/LLM/TTS）
都必须包在 `MLXLockContext` 里串行化。策略差异：

| 路径 | 超时 | 失败行为 |
|---|---|---|
| Parakeet progressive | 10ms | 跳过实时更新（不阻塞） |
| Parakeet final | 5s | 报错兜底 |
| Qwen3-TTS / Kokoro / MLX Whisper | 10s | 超时抛异常 |

### 8.3 PipelineLogFilter（log_context.py）

`pipeline_log_ctx`（ContextVar）记录 `pipeline_index`；日志格式
`%(pipeline_prefix)s%(name)s` 自动带 `[Pipeline N]` 前缀——多单元池的日志可区分归属。

---

## 9. 设计要点总结

1. **消息 vs 事件分离**：工作负载走链内队列，通知走侧信道直达客户端——解耦流水线与协议层。
2. **三类队列控制信号**（哨兵/控制消息）语义严格区分，flush 保留规则是正确性关键。
3. **代数取消取代布尔信号**：输出打 `cancel_generation` 标签，下游各阶段幂等可弃。
4. **推测性回合统一了打断竞态**：revision 递增让旧输出自动作废，阻塞/非阻塞两族接口
   适配线程与 asyncio 两种环境。
5. **GIL 依赖是刻意的**：CancelScope 无锁、队列 mutex 只用于原子批操作（flush/合并），
   保持简单。
6. **end-of-response 哨兵是状态机收敛点**：无 `AUDIO_RESPONSE_DONE` 则 in_response 卡死。

---

*本文档随代码演进维护；如与源码行为不一致，以 `src/speech_to_speech/pipeline/` 为准。*
