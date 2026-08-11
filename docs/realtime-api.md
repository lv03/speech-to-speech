# 实时层详解（OpenAI Realtime API 兼容）

> 对应源码：`src/speech_to_speech/api/openai_realtime/`（server.py / websocket_router.py /
> service.py / pipeline_unit.py / transports.py / webrtc_session.py / llm_proxy.py /
> audio_client.py / runtime_config.py / handlers/）。
> 配套概念：[架构与链路](architecture.md) §4/§6、[pipeline 基础设施](pipeline-infra.md)（取消作用域、推测性回合）。

---

## 1. 模块职责总览

| 模块 | 职责 |
|---|---|
| `server.py` | uvicorn 服务器；持有 PipelineUnit 池；`stop_event` 联动关闭 |
| `websocket_router.py` | FastAPI 路由（`/v1/realtime`、`/v1/usage`、`/v1/pool`、`/v1/realtime/calls`）+ **核心 send loop** + 会话领取/释放/隔离 |
| `service.py`（RealtimeService） | **协议状态机**：解析客户端事件、维护 `ConnState`、分发 pipeline 事件、UsageMetrics 计费 |
| `handlers/` | 四域处理器：`audio` / `conversation` / `response` / `session` |
| `pipeline_unit.py` | `PipelineUnit`（隔离单元）+ `SessionState`（会话生命周期状态） |
| `transports.py` | `SessionTransport` 抽象 + `WebSocketTransport` |
| `webrtc_session.py` | WebRTC 会话（SDP 协商、媒体轨道、oai-events 数据通道） |
| `llm_proxy.py` | Realtime 协议 → 上游 OpenAI 兼容 LLM 的透传代理 |
| `audio_client.py` | `local` 模式回环客户端（麦克风 → ws → 扬声器） |
| `runtime_config.py` | 随请求流转的会话配置 |

**核心对象关系**：

```
RealtimeServer (uvicorn, 1 个)
  └── pool: list[PipelineUnit]          # num_pipelines 个
        ├── service: RealtimeService    # 协议状态机 (含 Chat)
        ├── cancel_scope / events / 8 条队列 / handlers 链
        └── session: SessionState | None  # 当前认领会话
```

---

## 2. ConnState — 协议状态（service.py）

每个连接一个 `ConnState`（`register()` 创建，`unregister()` 销毁），包含：

| 字段 | 含义 |
|---|---|
| `session_id` / `conversation_id` | 协议级 ID |
| `runtime_config` | 会话配置（含 `Chat` 对话历史、`RealtimeSessionCreateRequest`） |
| `in_response` / `response_pending` | 响应状态机核心标志（卡死源头！） |
| `current_response_key` / `pending_response_keys` / `closed_response_keys` | **#453 新增**：响应标识管理——当前 key / 排队 key 集合 / 已关闭 key 集合（用于丢弃迟到输出） |
| `pending_text_outputs` | **#453 新增**：有序文本输出组装缓存 |
| `current_response_id` / `current_item_id` / `content_index` | 响应/条目/内容索引（协议输出项编号） |
| `pending_output_text_parts` / `pending_assistant_item_id` | assistant 输出项组装缓存 |
| `pending_function_calls` | 当前响应中模型请求的函数调用（`response.done` 的 output 需要） |
| `response_usage: UsageMetrics` | 本响应 token/音频统计 |
| `speculative_user_turn_id/revision` | 推测性用户回合（转写替换用） |
| `deferred_items` | **生成期间到达的 conversation.item.create 缓冲**（跨线程竞态，响应完成后再按序 flush） |

**UsageMetrics**：`input_tokens` / `output_tokens` / `audio_duration_s` /
`responses_completed` / `responses_cancelled` / `tool_calls` / `turns`，支持 `+=` 滚动汇总。
`GlobalUsageMetrics` 扩展：`connections` / `errors_by_type`。

---

## 3. 事件协议

### 3.1 客户端 → 服务端（`parse_client_event` + 分发）

`_EVENT_TYPE_TO_MODEL` 白名单解析，未知/非法事件回 `error`。分发逻辑
（`_dispatch_client_event`，`transport_kind` 门控 WebSocket/WebRTC 差异）：

| 事件 | WebSocket | WebRTC | 处理 |
|---|---|---|---|
| `input_audio_buffer.append` | ✅ | ❌ 拒绝（音频走媒体轨道） | 切块（512 样本/1024B）→ `unit.input_queue`（携带 runtime_config） |
| `input_audio_buffer.commit` | ✅ | ✅ | 触发 VAD 强制回合结束 |
| `output_audio_buffer.clear` | ❌ 拒绝 | ✅ | flush output_queue（保留哨兵）+ `transport.discard_pending_audio()`（对应 #455 bug 域） |
| `session.update` | ✅ | ✅ | 更新会话配置 → 回发 `session.updated` |
| `conversation.item.create` | ✅ | ✅ | 注入对话项（含工具执行结果）；**生成中到达的缓冲到 deferred_items** |
| `response.create` | ✅ | ✅ | 触发 LLM 生成；`cancel_scope.new_response()` 开启新代数 |
| `response.cancel` | ✅ | ✅ | `cancel_scope.cancel()` + flush 两队列 + `discard_pending_audio` + 回发 `response.cancelled` |

### 3.2 服务端 → 客户端

`session.created/updated`、`input_audio_buffer.speech_started/stopped`、
`conversation.item.created`、`input_audio_buffer.transcription.delta/completed`、
`response.created/done/cancelled`、`response.audio.delta/done`、
`response.audio_transcript.delta/done`、`response.text.delta/done`、
`response.function_call.arguments.done`、`error`。

### 3.3 pipeline 事件 → Realtime 事件映射（`dispatch_pipeline_event`）

`text_output_queue`（VAD/转写事件）与 `output_queue`（响应事件 + 音频）上的内部事件
经 `_pipeline_dispatch` 转成协议事件：#453 重构后 `AssistantOutputEvent`/
`AssistantResponseDoneEvent`/`TokenUsageEvent` **不再走 text_output_queue，与音频共享
output_queue**（保序）。

| PipelineEvent | → Realtime 事件 | 处理器 |
|---|---|---|
| `SpeechStartedEvent` | `input_audio_buffer.speech_started` | `audio.on_speech_started` |
| `SpeechStoppedEvent` | `input_audio_buffer.speech_stopped` | `audio.on_speech_stopped` |
| `PartialTranscriptionEvent` | `input_audio_buffer.transcription.delta` | `conversation.on_partial_transcription` |
| `TranscriptionCompletedEvent` | `transcription.completed` + 触发 LLM | `_on_transcription_completed` |
| `AudioInputCompletedEvent` | （stt=none 音频输入完成）→ 触发 LLM | `_on_audio_input_completed` |
| `AssistantOutputEvent` | `response.text.delta` / `function_call.arguments.done` | `response.on_assistant_output` |
| `AssistantResponseDoneEvent` | 有序输出结束标记（#453 新增） | `response.on_assistant_response_done` |
| `TokenUsageEvent` | 计费累积（无协议事件） | `_on_token_usage` |
| `ResponseFailedEvent` | `response.done(status="failed")` | `_on_response_failed` |

**stale 过滤**：`_is_stale_turn_event` 用 SpeculativeTurnTracker 判断回合是否最新；
AssistantText/TokenUsage 走 `is_latest_after_reopen_grace`（可阻塞等待），其余走
`is_latest`。非阻塞版本返回 `None` 表示需重试（send loop 会暂存）。

---

## 4. 四域处理器（handlers/）

### 4.1 AudioHandler

- `handle_audio_append`：累积音频，切块（`audio_remainder` 处理跨块边界）。
- `append_pcm`：WebRTC 媒体轨道直入（同切块逻辑）。
- `handle_audio_commit`：buffer 有数据才有效。
- `on_speech_started/stopped`：维护 `input_content_index`、开启/关闭输入条目。
- `begin_audio_response` / `begin_audio_output`：响应开头的音频输出条目 + content_index 分配。
- `encode_audio_chunk`：`response.audio.delta` 事件（Base64）。

### 4.2 ResponseHandler

- `_ensure_response`：`response.created` + 状态置 `in_response`。
- `handle_response_create`：会话级校验（`in_response` 时拒绝并回错误——**并发响应保护**）；
  out-of-band（`input` 在事件里）与默认会话两条路径。
- `handle_response_cancel` / `finish_response`：组装 `response.done`（含 output items、
  用法统计、status/reason）。
- `on_assistant_text`：文本 delta / 工具参数流式下发。
- `_build_output_items`：把 `pending_function_calls` 纳入 done 的 output（协议要求）。

### 4.3 ConversationHandler

- `handle_conversation_item_create`：校验 + 写入 Chat（`conversation.item.created` 回发）。
- `_apply_item`：支持 user 文本、**音频（base64 WAV）**、function_call_output。
- `flush_deferred_items`：响应完成后按序 flush 缓冲的条目。
- `on_partial_transcription` / `on_transcription_completed`：转写事件 → 协议事件。

### 4.4 SessionHandler

- `handle_session_update`：白名单字段校验 → 更新 `runtime_config`。
- `build_session_created/updated`：回发事件。

---

## 5. websocket_router：路由 + send loop

### 5.1 会话领取与释放

```
WebSocket:  accept → _claim_unit(transport) → service.register() → session.created
WebRTC:     POST /v1/realtime/calls (SDP offer) → _claim_unit(None) → register
            → WebRTCSession.setup() → unit.session.transport = session → negotiate()
            → 返回 SDP answer (201, Location: /v1/realtime/calls/{id})
            DELETE /v1/realtime/calls/{id} → transport.close() → on_closed → 释放

释放 (统一路径 _release_session):
  1. old_session.released_at 置位
  2. _clean_unit: cancel_scope.cancel() + flush 4 队列(保留哨兵) + reset + should_listen.set()
  3. 注入 SESSION_END(session_id 标记) → 沿 handler 链传播
  4. asyncio task 等待 session.drained (send loop 观察到 SESSION_END 置位)
  5. unregister 会话 (关闭 Chat, 汇总 usage) → unit.session = None
```

异常路径（详见 [architecture.md](architecture.md) §4.2）：

- drain 超时 10s → 告警。
- 隔离 180s → `quarantined_at` 置位 + 立即 unregister，unit 保持"stuck"直到真正 drain。
- 释放**不 await**：在 finally 里 spawn task 立即返回（WebSocketDisconnect 后 await
  可能被 Starlette runner 跳过）。

### 5.2 send loop（每 unit 一个 asyncio task）

```
循环 (10ms 间隔):
  A. text_output_queue (VAD/转写事件优先):
     SpeechStartedEvent → 打断逻辑:
        ├─ interrupt_response_enabled: cancel_scope.cancel()
        │    + close_pending_responses(session_id)
        │    + flush 音频/文本/提示队列 + discard_pending_audio (WebRTC)
        │    + response_playing.clear()
        └─ 禁用: 仅记日志
     (生成中 speech_started: in_response 或 response_pending → 打断/忽略)

  B. output_queue (响应事件 + 音频混合, #453 后):
     pending_output_item 优先 (上轮暂存) → 否则 get_nowait
     TokenUsageEvent → dispatch → 发送 (计费)
     AssistantOutputEvent / AssistantResponseDoneEvent →
        generation 可丢弃检查 → response_key 过期检查
        (_response_key_is_obsolete → close_response_key + 丢弃)
        → dispatch_pipeline_event → 发送
     PIPELINE_END → finish_response + break (关停)
     AUDIO_RESPONSE_DONE → finish_response + response_pending=False
                          + response_playing.clear() + response_done(gen) + should_listen.set()
        └─ cleanup_only 的 done → 只清理响应状态 (stale 收尾)
        └─ stale generation 的 done → 只解锁 should_listen
     SESSION_END → session.drained.set() (链已复位, 释放可继续)
     音频 → 批处理: 攒满 MAX_AUDIO_BATCH_BYTES(6400B) 再发 (减少 WebSocket 帧数)
            中途遇哨兵/控制消息 → 暂存 pending_output_item
            _should_discard_audio (generation 检查) → 丢弃
            → transport.send_audio_chunk (Base64 delta)
```

**关键细节**：

- **#453 核心变化**：assistant 文本/工具/计费事件不再单独走 text_output_queue，而是与
  音频在同一队列按序到达；send loop 按 `response_key` 区分响应，`_output_part_context`
  管理有序输出索引（连续文本共享一个 assistant item，工具调用开新 item）。
- 音频批处理减少帧开销；哨兵绝不进批（暂存到 pending_output_item 供下轮处理）。
- `response_playing` / `should_listen` 在首个音频块时置位——打断窗口以音频开始为准。
- 文本事件（speech_started）先于音频处理：`speech_started` 必须先被看到才能正确打断。

### 5.3 监控端点

- `GET /v1/usage`：跨池聚合 UsageMetrics（数值求和、dict 深合并）+ `llm_proxy` 计费。
- `GET /v1/pool`：`idle` / `active` / `draining` / `stuck` 四态 + 耗时（运维定位卡死 handler）。

---

## 6. 双传输

### 6.1 SessionTransport 抽象

```
send_events(events)           # JSON 事件
send_audio_chunk(service, session_id, pcm)  # 音频 (encode_audio_chunk → delta)
discard_pending_audio()       # 丢弃未播音频 (WebRTC 才有意义)
close()
```

### 6.2 WebSocket（`/v1/realtime`）

- 音频走 `input_audio_buffer.append`；音频输出走 `response.audio.delta`。
- `discard_pending_audio` 是 no-op（未播音频在客户端侧）。

### 6.3 WebRTC（`/v1/realtime/calls`）

- 音频走**媒体轨道**（PCM16 → `append_pcm`）；事件走 `oai-events` 数据通道（同 JSON 协议）。
- `output_audio_buffer.clear` 仅 WebRTC 可用；`input_audio_buffer.append` 被拒。
- SDP 协商：POST offer → 201 answer；`Location` 头给 hangup URL；DELETE 挂断。
- 需要 `webrtc` extra（aiortc），未安装时返回 501。

---

## 7. LLM 代理（llm_proxy.py）

`--enable_llm_proxy` 时挂载：把 Realtime 协议**透传**到上游 OpenAI 兼容服务器
（如本地 llama.cpp / vLLM 的 realtime 端点），无需本地模型。

- `mount_llm_proxy(app, config)`：挂载上游的 `responses` 相关路由（passthrough 流式转发）。
- 代理流量独立计费（`LLMProxyUsage`：请求数、status 分类、token 载荷、SSE 事件数），
  出现在 `/v1/usage` 的 `llm_proxy` 字段。
- 上游不可达 → 结构化错误响应（`_upstream_unreachable`）。
- `LLMProxyConfig` 由 `build_llm_proxy_config` 从所选 LLM 后端的 base_url/api_key/model 构建；
  需要 LLM 后端 `supports_llm_proxy` 能力标记。

---

## 8. 回环音频客户端（audio_client.py，`local` 模式）

```
麦克风 → pyaudio 回调 → ws input_audio_buffer.append → 服务器
服务器响应音频 → response.audio.delta → PlaybackBuffer → 扬声器
```

- `RealtimeAudioClientConfig`：url 归一化（ws/wss）、chunk_size、输入/输出设备、
  `block_mic_during_playback`（播放时闭麦，靠 `should_listen` + 本地计时）。
- `PlaybackBuffer`：跨声道 PCM 缓冲、可 clear（打断时清空待播）。
- `_FriendlyEventRenderer`：终端友好渲染（实时用户文本、assistant 流式字幕）。

---

## 9. 会话生命周期时序图

```
客户端                    WebSocketRouter                 RealtimeService           PipelineUnit
  │  connect                 │                                │                        │
  │─────────────────────────►│ accept                          │                        │
  │                          │ _claim_unit                     │                        │
  │                          │──────────────────────────────────────────────────────────► session=SessionState
  │                          │ register()                      │                        │
  │                          │────────────────────────────────►│ 创建 ConnState + Chat   │
  │ ◄── session.created ─────│                                 │                        │
  │  append/commit/create...  │ _dispatch_client_event          │ 状态机更新              │
  │─────────────────────────►│────────────────────────────────►│                        │
  │                          │ 音频→input_queue / 事件→Chat    │                        │
  │                          │                                 │ TranscriptionCompleted  │
  │                          │◄────────────────────────────────│ → GenerateResponseRequest
  │                          │                                 │   → text_prompt_queue   │
  │ ◄── speech_started ──────│◄── SpeechStartedEvent ──────────│                        │
  │ ◄── text.delta ──────────│◄── AssistantOutputEvent ──────│  (LLM 链, 与音频同队列)              │
  │ ◄── audio.delta ─────────│◄── output_queue 音频块 ─────────│  (TTS 链)              │
  │ ◄── response.done ───────│◄── AUDIO_RESPONSE_DONE ─────────│                        │
  │  disconnect              │                                 │                        │
  │─────────────────────────►│ _release_session                 │                        │
  │                          │ _clean_unit + SESSION_END ──────► 沿 handler 链传播      │
  │                          │◄─────────────────────────────────────────────────────── drain
  │                          │ unregister() → 释放 unit         │                        │
```

---

## 10. 设计要点总结

1. **一个 unit 一个 send loop**：VAD/转写事件先于音频处理（speech_started 必须先被看到）；
   响应事件与音频同队列按序消费（#453）。
2. **响应状态机（in_response/response_pending）**是正确性核心：任何异常都必须
   `finish_response` 收敛，否则后续 response.create 被拒（LLM 的 EndOfResponse 哨兵保证）。
3. **打断是 send loop 的职责**：`cancel_scope.cancel()` + flush 队列 + discard 音频，
   保留哨兵（`_keep_audio_sentinel`）防止 drain 死等。
4. **会话释放是异步任务**：SESSION_END 走完整条链确认复位后才归还 unit，
   隔离（quarantine）防跨会话泄漏。
5. **WebRTC/WebSocket 语义差异**：append/clear 事件合法性按 transport_kind 门控。
6. **deferred_items**：生成中的 conversation.item.create 不直接写 Chat（跨线程竞态），
   响应完成按序 flush——对应 #454 的乱序修复域。
7. **代理计费独立**：llm_proxy 流量不进 unit 级 usage，聚合时单独并入。

---

*本文档随代码演进维护；如与源码行为不一致，以 `src/speech_to_speech/api/openai_realtime/` 为准。*
