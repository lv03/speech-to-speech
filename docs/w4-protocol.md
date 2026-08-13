# W4 学习讲义 —— 网络与协议

> 配套：[面试准备清单](interview-prep.md) D1-D4 · 目标：能画双通道架构图、能报出事件表
> 周验收：默画双通道图 + 报出客户端/服务端事件表 + 讲清协议差异 3 分钟

---

## D1 为什么用 OpenAI Realtime 协议

> 完整话术在 [P0-5 速记卡](interview-prep.md)，这里给结构。

**五点**：
1. **生态标准**：官方 SDK/浏览器/移动端客户端开箱即用，免自研
2. **能力完备**：实时语音要的事件面（音频缓冲/语音边界/实时转写/流式音频/工具调用/会话配置）协议全给，自研成本高
3. **前后端解耦**：后端专注模型管线，前端复用成熟生态
4. **双通道**：协议天然支持 WebSocket（简单）与 WebRTC（低延迟）
5. **迁移红利**：已有 OpenAI Realtime 应用可零改动切换（README endpoint-swap 演示）

**注意定位**：本项目是 **Realtime 传输 + Responses API 响应命名** 的变体（不是 100% 标准 OpenAI Realtime），对外声称"兼容"而不是"实现标准"。

---

## D2 WebSocket vs WebRTC

### WebSocket（TCP 消息通道）

```
浏览器 ── HTTP Upgrade（101 Switching Protocols）──► 服务器
  · 同一个 TCP 连接上全双工发消息（帧：文本/二进制）
  · 本项目音频：PCM16 → base64 → JSON 事件帧（input_audio_buffer.append）
  · 优点：实现简单、走 80/443 天然穿透防火墙、浏览器支持好、易调试
  · 缺点：base64 膨胀 33%、TCP 队头阻塞、音频当应用层消息（有开销）
```

### WebRTC（UDP/SRTP 媒体通道）

```
浏览器 ── SDP offer/answer 信令协商 ──► 服务器
  · 音频走媒体轨道（MediaStreamTrack）→ SRTP over UDP，原始流无编码开销
  · JSON 事件走 DataChannel（类似 WebSocket 的消息通道）
  · 需 ICE 打洞：STUN（公网地址发现）/ TURN（对称 NAT 中继）
  · 优点：低延迟（UDP 无队头阻塞）、无 base64 开销、专业媒体管道
  · 缺点：实现复杂（SDP/ICE/TURN）、公网需额外 TURN 服务器、部分网络打洞失败
```

### 为什么并存（5 点，必背）

1. **场景差异**：WebSocket 适合简单可靠/内网/调试/原型；WebRTC 适合公网低延迟高质量语音
2. **客户端生态**：官方 SDK/多数库只有 WebSocket 客户端；WebRTC 主要在浏览器/移动端原生
3. **穿透性**：WebSocket 走 80/443 天然穿透；WebRTC 依赖 ICE/TURN，复杂网络可能失败——双通道互为冗余
4. **架构成本低**：协议状态机（RealtimeService）与事件处理完全复用，差异只隔离在 **SessionTransport 适配器层**（音频通道 + 事件合法性门控）——加一种传输不碰核心逻辑
5. **默认策略**：WebSocket 零额外设施为默认；WebRTC 可选（`--extra webrtc`）

### 实现差异点（被追问时）

| 事件/通道 | WebSocket | WebRTC |
|---|---|---|
| 输入音频 | `input_audio_buffer.append` | 媒体轨道（append 被拒，`invalid_event_for_transport`） |
| `output_audio_buffer.clear` | 拒绝（未播音频在客户端侧） | 支持 |
| 事件通道 | 同一个 WebSocket | `oai-events` 数据通道 |
| 服务端挂断 | 关闭 WS | `DELETE /v1/realtime/calls/{id}` |

---

## D3 与标准 OpenAI Realtime 的差异（必背表）

| 点 | 本项目 | 标准 OpenAI Realtime |
|---|---|---|
| 音频输出事件 | `response.output_audio.delta`（Responses API 命名） | `response.audio.delta` |
| 字幕事件 | `response.output_audio_transcript.delta` | `response.audio_transcript.delta` |
| 文本事件 | `response.output_text.delta` | `response.text.delta` |
| 会话配置 | **GA schema**（`session.audio.input/output`） | 旧 schema（`session.input_audio_transcription`） |
| `session.updated` 回执 | 不主动回 | 回 |
| `response.done` 结构 | `status`/`output` 在**子对象 `response`** 里 | 顶层含 `status` |
| 输出采样率 | 客户端可配（`session.audio.output.format.rate`，demo 用 24k） | 固定 24k |

**兼容细节**：demo 前端同时监听两种命名（`response.audio.delta` 和 `response.output_audio.delta`）——旧客户端兼容策略。

---

## D4 事件表（要能报出来）

### 客户端 → 服务端（7 个）

| 事件 | 说明 |
|---|---|
| `session.update` | GA schema 配置会话（先发音频前必发） |
| `input_audio_buffer.append` | 音频块（PCM16 16k base64，每块 1024B），仅 WS |
| `input_audio_buffer.commit` | 强制结束音频段（触发 VAD 回合结束） |
| `output_audio_buffer.clear` | 清空待播音频，仅 WebRTC |
| `conversation.item.create` | 注入对话项（user 文本/音频、工具执行结果、图片） |
| `response.create` | 触发生成（可带 input/tools/voice 覆盖） |
| `response.cancel` | 取消当前响应 |

### 服务端 → 客户端（主要 12 个）

| 事件 | 含义 |
|---|---|
| `session.created` / `session.updated` | 会话建立 / 更新回执 |
| `input_audio_buffer.speech_started` / `.stopped` | VAD 语音边界 |
| `conversation.item.input_audio_transcription.delta` / `.completed` | 用户语音实时转写 / 最终转写 |
| `response.created` / `.done` | 响应开始 / 结束（status/output 在 response 子对象） |
| `response.output_audio.delta` / `.done` | TTS 音频流 / 结束（PCM16 base64） |
| `response.output_audio_transcript.delta` / `.done` | TTS 实时字幕 |
| `response.output_text.delta` / `.done` | 文本模式输出 |
| `response.function_call.arguments.done` | 工具调用参数（call_id） |
| `error` | 错误（type/message） |

### 一次完整对话时序（要能画）

```
浏览器                        speech-to-speech
  │── session.update ─────────► 配置（GA schema）
  │── append × N ────────────► input_queue → VAD
  │── commit ────────────────► 强制回合结束
  │◄── speech_started ───────── VAD 确认
  │◄── transcription.delta ──── STT 实时转写
  │── response.create ───────► LLM 生成
  │◄── response.created ───────
  │◄── output_audio_transcript.delta ── 字幕先行
  │◄── output_audio.delta × N ──── TTS 音频流
  │◄── output_audio.done ──────
  │◄── response.done ───────── (response.status=completed)
```

---

## 周验收自测

1. **默画双通道架构图**（WS/WebRTC + SessionTransport 适配器 + 共享 RealtimeService）
2. **报出**：WS vs WebRTC 本质差异（TCP 消息 + base64 vs UDP/SRTP 媒体轨道 + DataChannel）
3. **讲清并存 5 点**：场景/生态/穿透/架构成本/默认策略
4. **报出差异表**：output_audio 命名、GA schema、done 子对象、session.updated
5. **报出 7 + 12 事件**：客户端 7 个、服务端 12 个
6. **默画完整对话时序**（session.update → append → commit → 转写 → 响应 → 音频 → done）

---

*W4 讲义完 · 下一篇：W5 部署与推理实战*
