# 通信协议详解（OpenAI Realtime 兼容变体）

> 对应源码：`src/speech_to_speech/api/openai_realtime/`（websocket_router.py / service.py /
> handlers/audio.py / handlers/response.py / transports.py / webrtc_session.py）。
> 配套概念：[实时层详解](realtime-api.md)（协议状态机与 send loop）、[架构与链路](architecture.md) §6。
> 前端参考：`demo/ws/s2s-ws-client.js`（浏览器客户端实现）。

---

## 1. 总览

项目对外暴露 **OpenAI Realtime 协议的自定义变体**：传输层与输入事件遵循 Realtime 规范，
但**响应事件采用 OpenAI Responses API 命名风格**（`response.output_audio.delta` 而非
`response.audio.delta`）。任何 OpenAI Realtime 兼容客户端需按本文档事件名接入。

```
传输: WebSocket (默认) / WebRTC (可选)
输入音频: PCM16 16kHz 单声道 base64
输出音频: PCM16 24kHz 单声道 base64
事件: JSON (OpenAI Realtime schema + Responses API 响应命名)
```

---

## 2. 传输层

| 传输 | 端点 | 音频通道 | 可用条件 |
|---|---|---|---|
| **WebSocket**（默认） | `ws://host:port/v1/realtime` | `input_audio_buffer.append` 事件 | 始终可用 |
| **WebRTC** | `POST /v1/realtime/calls`（SDP offer → answer） | 媒体轨道（PCM16）；事件走 `oai-events` 数据通道 | 需 `webrtc` extra（aiortc） |

**WebRTC 细节**：

- 客户端 POST `Content-Type: application/sdp` 的 SDP offer → 201 answer，
  `Location: /v1/realtime/calls/{session_id}`；`DELETE` 该 URL 挂断。
- `input_audio_buffer.append` 在 WebRTC 下**被拒**（`invalid_event_for_transport`）。
- `output_audio_buffer.clear` 仅 WebRTC 可用（WebSocket 下未播音频在客户端侧）。

---

## 3. 音频格式

| 方向 | 格式 | 分块 |
|---|---|---|
| 输入 | **PCM16 / 16kHz / 单声道** base64 | 每块 512 样本 = 1024 字节（`input_audio_buffer.append`） |
| 输出 | **PCM16 / 24kHz / 单声道** base64 | send loop 攒满 `MAX_AUDIO_BATCH_BYTES`(6400B) 合并发送 |

> TTS 后端输出 16kHz，send loop 经 `service.encode_audio_chunk` 输出 24kHz
> （demo 前端按 24kHz 解码播放）。

---

## 4. 客户端 → 服务端事件

| 事件 | 传输限制 | 处理 |
|---|---|---|
| `session.update` | — | GA schema（`session.audio.input/output`）；**服务端不回 `session.updated`**（demo 靠消息顺序保证） |
| `input_audio_buffer.append` | 仅 WebSocket | 切块（512 样本）→ `unit.input_queue`（携带 runtime_config） |
| `input_audio_buffer.commit` | — | 触发 VAD 强制回合结束 |
| `output_audio_buffer.clear` | 仅 WebRTC | flush output_queue（保留哨兵）+ `transport.discard_pending_audio()` |
| `conversation.item.create` | — | 注入对话项（user 文本/音频、function_call_output、图片）；生成中到达的缓冲到 `deferred_items` |
| `response.create` | — | 触发生成；可带 `input`（out-of-band）、`tools`、`tool_choice`、`instructions`、`voice` 覆盖；开启新 cancel 代数 |
| `response.cancel` | — | `cancel_scope.cancel()` + flush 队列 + 回发 `response.cancelled` |

---

## 5. 服务端 → 客户端事件

### 5.1 会话与语音

| 事件 | 含义 |
|---|---|
| `session.created` | 连接建立（含默认会话配置） |
| `session.updated` | 仅当客户端显式请求时回发（`build_session_updated` 调用路径） |
| `input_audio_buffer.speech_started` / `.stopped` | VAD 语音边界（`speech_started` 的 `interrupt_response` 由会话配置控制） |
| `conversation.item.input_audio_transcription.delta` | 用户语音**实时转写**（progressive） |
| `conversation.item.input_audio_transcription.completed` | 最终转写（触发 LLM） |

### 5.2 响应与输出（Responses API 命名）

| 事件 | 含义 |
|---|---|
| `response.created` | 响应开始（含 `id`） |
| `response.output_audio.delta` / `.done` | **TTS 音频流**（PCM16 24kHz base64）/ 结束 |
| `response.output_audio_transcript.delta` / `.done` | **TTS 实时字幕** |
| `response.output_text.delta` / `.done` | 文本模式输出 |
| `response.function_call.arguments.done` | 工具调用参数（含 `call_id`） |
| `response.done` | 响应结束；`status`/`output` 在**子对象** `response` 内（`response.status` / `response.output`），含 usage 统计 |
| `response.cancelled` | 响应被取消 |
| `error` | 错误（`error.type` / `error.message`） |

---

## 6. 与标准 OpenAI Realtime 协议的差异

| 点 | 本项目 | 标准 OpenAI Realtime |
|---|---|---|
| 音频输出事件名 | **`response.output_audio.delta`**（Responses API 风格） | `response.audio.delta` |
| 字幕事件名 | `response.output_audio_transcript.delta` | `response.audio_transcript.delta` |
| 文本事件名 | `response.output_text.delta` | `response.text.delta` |
| 会话配置结构 | GA schema（`session.audio.input/output`） | 旧 schema（`session.input_audio_transcription` 等） |
| `session.updated` 回执 | 不主动回 | 回 |
| 音频输出采样率 | 24kHz | 24kHz（一致） |
| `response.done` 结构 | `status`/`output` 在 `response` 子对象 | 顶层含 `status` 等 |

> demo 前端（`demo/ws/s2s-ws-client.js:752`）**同时兼容** `response.audio.delta` 与
> `response.output_audio.delta` 两种命名。

---

## 7. 完整对话时序

```
浏览器                demo/server            speech-to-speech
  │── session.update ────► (代理/直连) ────► 更新会话配置 (GA schema)
  │── append × N ────────► ────────────────► input_queue → VAD (16kHz PCM16)
  │── commit ───────────► ────────────────► 强制回合结束
  │◄── speech_started ──── ─────────────────► VAD 确认语音
  │◄── transcription.delta ────────────────► STT 实时转写 (progressive)
  │── response.create ──► ────────────────► LLM 生成
  │◄── response.created ───────────────────►
  │◄── output_audio_transcript.delta ──────► (TTS 字幕先行)
  │◄── output_audio.delta × N ─────────────► TTS 合成流式下发 (24kHz PCM16 base64)
  │◄── output_audio.done ──────────────────►
  │◄── response.done ──────────────────────► (response.status=completed, 含 usage)
```

### 工具调用时序（含多轮）

```
客户端 ── response.create(带 tools) ──► 服务端
服务端 ── response.output_text.delta ──► (可选前置语音)
服务端 ── response.function_call.arguments.done(call_id) ──► 客户端
客户端执行工具
客户端 ── conversation.item.create(function_call_output) ──► 服务端 → Chat
客户端 ── response.create ──► 新一轮生成（LLM 携带工具结果）
```

### 打断时序（barge-in）

```
用户再次说话
服务端 ── input_audio_buffer.speech_started ──► 客户端
服务端内部: cancel_scope.cancel() + flush 音频队列 + close_pending_responses
服务端 ── response.cancelled(旧) ──► 客户端
服务端 ── 新一轮 response.created ──► ...
```

---

## 8. 关键实现要点（客户端接入须知）

1. **必须先 `session.update` 再发音频**：demo 客户端在 `session.update` 前不发
   `input_audio_buffer.append`（服务端拒绝未配置会话的音频）。
2. **音频块节奏**：demo 每 ~40ms 发一帧（1024 字节 PCM16）；`response.create` 应
   在 `commit` 之后。
3. **`response.done` 解析**：`status` / `output` / `usage` 都在事件对象的
   `response` 子对象里（顶层只有 `type` / `event_id` / `response`）。
4. **字幕与音频并行**：`output_audio_transcript.delta` 与 `output_audio.delta`
   交错到达，客户端按需渲染。
5. **WebRTC 事件通道**：事件走 `oai-events` 数据通道（同 JSON 协议），音频走媒体轨道；
   demo 的 `/api/calls` 代理转发 SDP（服务端侧拨号）。
6. **协议版本演进**：#453 重构后响应事件统一为 `response.output_*` 命名；
   旧客户端可同时监听两种命名做兼容。

---

*本文档随代码演进维护；如与源码行为不一致，以 `src/speech_to_speech/api/openai_realtime/` 与 `demo/` 为准。*
