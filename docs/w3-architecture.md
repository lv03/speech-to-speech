# W3 学习讲义 —— 系统架构与并发

> 配套：[面试准备清单](interview-prep.md) C1-C6 · 目标：能画线程模型图、讲清打断与会话生命周期
> 周验收：默画线程模型图 + 打断时序 + 会话生命周期图，各讲 2 分钟

---

## C1 线程 vs asyncio（混合架构）

### 概念

| | asyncio | 多线程 |
|---|---|---|
| 模型 | 单线程事件循环 | 多线程并发 |
| 适合 | **I/O 密集**（网络等待、读文件） | **计算密集**（模型推理） |
| 关键点 | await 让出循环；阻塞会卡死所有并发 | GIL 限制纯 Python 并行 |

### 为什么推理不能放 asyncio

```
模型推理（torch/mlx 前向传播）= CPU/GPU 密集【阻塞】调用，不会 await 让出
若推理阻塞在事件循环 → 一个请求的推理卡住所有连接
```

### 项目实际（混合架构，要能画）

```
┌──────────────────────── asyncio 层（uvicorn/FastAPI）────────────────────────┐
│  WebSocket 路由：接收 append → 音频块丢进 input_queue                        │
│  send loop：从 output_queue 取音频/事件 → 编码 → 发回客户端                   │
└───────────────┬────────────────────────────────┬───────────────────────────┘
                ▼ input_queue                     ▲ output_queue
┌──────────────────────── 线程层（推理链） ─────────────────────────────────────┐
│  [VAD 线程] → [STT 线程] → [LLM 线程] → [TTS 线程]  （各自独立线程 + 队列连接）  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**一句话**：网络 I/O 用 asyncio（uvicorn），模型推理用多线程，线程之间用线程安全队列，两边队列桥接。

### GIL 不是问题的原因（加分）

- torch/mlx/numpy 底层是 **C 实现，前向传播时释放 GIL** → 流水线各阶段真并行
- GIL 只卡纯 Python 计算（转写后处理等），占比小
- **真正的并发坑是 MLX**（见 C5）

### 为什么不用多进程

- 每进程复制模型权重 → 内存翻倍（8B 模型 × 4 进程）
- MLX/torch 非多进程安全

---

## C2 打断一致性（三件套）

### 机制一：推测性回合（turn_id / revision）

```
用户说话 → VAD 分配 turn_id（turn_1）+ revision（0）
语音软结束 → 进入 reopen 宽限期（speculative_reopen_ms=800ms / SmartTurn 判定后 2s）
  ├─ 宽限内用户补话 → 重开同一回合，revision+1
  │    → 旧 revision 的所有输出（转写/LLM/TTS）被下游 is_latest 检查丢弃
  └─ 宽限过 / LLM 输出已提交 → 回合锁定，新语音开新回合
```

### 机制二：代数式取消（cancel_scope.generation）

```
每次 response.create → generation 递增（0xFFFFFFFF 回绕）
所有输出（音频/文本/计费）打 cancel_generation 标签
send loop：is_stale(gen) 或 丢弃窗口内非当前代数 → 幂等丢弃
文本与音频同规则 → 不会出现"文本是新的、音频是旧的"不同步
```

### 机制三：Smart Turn 说完判定

```
语音结束后本地分类器判断"说完了吗"
  ├─ 说完 → 短宽限 800ms，快速响应
  └─ 没说完 → 长宽限 2s + 延迟 STT/LLM 处理（给补话时间）
打断发生时：cancel_scope.cancel() + flush 队列（保留哨兵）+ discard_pending_audio(WebRTC)
```

### 完整打断时序（要能画）

```
用户说话 ──► VAD speech_started ──► send loop 检测到
  ├─ interrupt 开启：cancel_scope.cancel() → close_pending_responses → flush 队列 → response.cancelled
  └─ interrupt 关闭：忽略（不打断）
新语音 → 新回合/重开 → 新一轮生成
```

---

## C3 多后端可插拔（后端注册表）

### BackendSpec（每个后端一条元数据）

```
name（CLI 选择名）/ kind（stt/llm/tts）/ config_type（参数类）
create_handler（工厂）/ config_prefix（参数前缀）/ required_extra（可选依赖）
capabilities（能力标记）
```

### 能力标记（驱动管线拓扑，必背）

| 标记 | 哪个后端 | 影响 |
|---|---|---|
| `bypasses_transcription_notifier` | stt=none | 跳过转写通知器，STT 直连 LLM |
| `supports_audio_input` | chat-completions | 允许 --stt none（音频直接进 LLM） |
| `supports_llm_proxy` | responses-api / chat-completions | 允许 --enable_llm_proxy |

### 加一个新后端的流程（被问必答）

```
1. arguments_classes/ 建参数 dataclass
2. STT|LLM|TTS/ 建 handler（继承对应基类）
3. backend_registry.py 注册 BackendSpec（工厂 + 能力标记）
4. 需要可选依赖 → pyproject 加 extra
→ 核心管线代码零改动
```

### 配置三阶段

```
参数 dataclass → normalize（剥离前缀、gen_kwargs 聚合）→ deepcopy（每 PipelineUnit 独立副本，防共享可变状态泄漏）
```

---

## C4 多会话隔离（PipelineUnit 池）

### 池结构

```
RealtimeServer（一个 uvicorn）
  └── pool: PipelineUnit × num_pipelines
        每个 unit 完全隔离：
          · 8 条队列 / CancelScope / SpeculativeTurnTracker / should_listen
          · RealtimeService（含独立 Chat 对话历史）
          · 整条 handler 链实例（配置 deepcopy，防 setup 时三方库共享状态）
```

### 会话生命周期（claim → release）

```
accept → _claim_unit（找 session=None 的空闲 unit）→ 池满则拒绝（session_limit_reached）
  → service.register()（ConnState + Chat）→ session.created
断开 → _release_session:
  1. _clean_unit：cancel_scope.cancel() + flush 4 队列（保留哨兵）+ reset
  2. 注入 SESSION_END（带 session_id）→ 沿 handler 链传播（on_session_end 重置状态）
  3. send loop 观察到 SESSION_END 回到 output_queue → 置 session.drained
  4. unregister（关闭 Chat，汇总 usage）→ unit.session = None（释放）
```

### 为什么必须等 SESSION_END 传播完才释放（面试必问）

```
已跑起来的 handler 可能产出【不带会话身份】的迟到输出（如转写）
若马上释放给新会话 → 旧会话的迟到输出串进新会话 → 跨会话泄漏
所以：释放是异步 task，等 SESSION_END 走完整条链确认复位后才归还 unit
超时 180s → quarantine（隔离，unit 保持"stuck"不可领取）
```

---

## C5 MLX 并发安全（Apple Silicon 特有）

### 为什么危险

```
MLX 推理共享【单一 Metal 命令队列】
并发调用直接崩进程：
  "Completed handler provided after commit call"
```

### 解决：全局锁 + 差异化超时

```
所有 MLX 路径包在 MLXLockContext 里串行化：

| 路径 | 超时 | 失败行为 |
|---|---|---|
| Parakeet progressive（实时转写） | 10ms | 抢不到就跳过（不阻塞语音流） |
| Parakeet final（最终转写） | 5s | 必须完成 |
| Qwen3-TTS / Kokoro | 10s | 超时抛异常 |
```

### 连带影响（加分细节）

```
多单元池（num_pipelines>1）+ Apple Silicon → 自动禁用 live transcription
（progressive 转写会争抢全局 MLX 锁，日志刷屏）
```

---

## C6 会话生命周期细节（/v1/pool 四态）

### 状态机

```
idle（空闲可领）→ active（会话进行中）
  → released 后等待 drain → draining（SESSION_END 传播中）
  → 超过 180s 未 drain → stuck（quarantine，直到链真正复位才回池）
```

### 监控端点

```
GET /v1/pool：size / in_use / 每 unit 的 state + 耗时（运维定位卡死 handler）
GET /v1/usage：跨池聚合 UsageMetrics + llm_proxy 计费
```

### 为什么释放不 await（细节）

```
WebSocketDisconnect 后 finally 里 spawn 异步 task 立即返回
（await 可能被 Starlette runner 跳过/取消，不可靠）
```

---

## 周验收自测

1. **默画线程模型图**（asyncio 层 + 线程层 + 队列桥接）
2. **报出**：GIL 为什么不是瓶颈 / MLX 为什么是瓶颈
3. **默画打断时序**（speech_started → cancel → flush → 新回合）
4. **讲清**：为什么释放要等 SESSION_END 传播（跨会话泄漏场景）
5. **报数字**：progressive 10ms / final 5s / TTS 10s / quarantine 180s
6. **讲清**：加后端四步 + 能力标记三个布尔
7. **默画会话生命周期**（claim→register→drain→release→quarantine）

---

*W3 讲义完 · 下一篇：W4 网络与协议*
