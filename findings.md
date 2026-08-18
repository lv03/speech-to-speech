# Findings & Decisions

> 目标：为 speech-to-speech 增加「自己的桌面端 + 通过 ACP 驱动 coding agent」能力。
> 本文档记录对 qwen-audio-agent 的深度分析、speech-to-speech 现状、技术选型结论。

## Requirements

- 一个自己的桌面端（类似 qwen-audio-agent 的桌面悬浮球 floating orb）
- 通过 ACP（Agent Client Protocol）驱动 coding agent 做事情
- 复用 speech-to-speech 已有的本地语音引擎（VAD→STT→LLM→TTS）和唤醒词/声纹

## Research Findings

### 1. qwen-audio-agent 总体架构（三层）

```
WebUI / TUI / Desktop(Electron orb)     ← 可替换的 Gateway 客户端
        │ WebSocket + HTTP
Realtime Gateway (Node.js server)       ← 核心服务
        ├─ Realtime frontend（语音：DashScope 或 speech-to-speech）
        ├─ Work queue（任务队列 + 状态机）
        └─ spawn_thinking 工具 ──► Backend Agent
                                    │ ACP (stdio + JSON-RPC 2.0)
                                    ▼
                    OpenCode / OpenClaw / Codex / Claude Code / Kimi ...
```

- **一层语音（Realtime frontend）**：全双工对话，只保留极小的工具集（spawn_thinking、
  schedule_reminder、memory、notes 等），不直接做多步编排。
- **二层协调（Coordinator Session）**：一个**固定持久**的 backend Agent Session，
  身份为 `qwen-audio-agent:<owner>:backend`。收到 final ASR 后，把请求包成
  `qwen-audio-agent.coordination.v1` envelope，让 backend Agent 返回结构化 JSON：
  `{work_id, state, mode, presentation:{speech, inline}}`。
- **三层任务（Project Sessions）**：backend Agent 通过注入的 MCP 工具
  `session_start / session_send / session_status / session_cancel` 把耗时工作
  委派到独立的 project Session，异步执行。

### 2. ACP 集成机制（核心，`server/src/agent/`）

**传输层**：`AcpProcessClient`（acp-process-client.mjs）
- 用官方 SDK `@agentclientprotocol/sdk`（npm 包）
- 通过 `spawn(command, args)` 启动后端 agent 为 stdio 子进程
- `acp.ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout))` 建立流
- ACP 方法：`agent.initialize`（协议握手，校验 protocolVersion）、
  `agent.session.new` / `session.resume` / `session.load`、`session.prompt`、
  `session.cancel`、`session.list`、`session.setConfigOption`
- 关键工程细节：
  - 每个 prompt 带独立 AbortController + 超时（默认 300s），超时自动 `session.cancel`
  - 权限请求（`session.requestPermission`）会**暂停**超时计时器
  - 进程树清理：SIGTERM → 750ms 宽限 → SIGKILL（Windows 用 taskkill /T）
  - stderr 截断到 12k 字符，用于诊断

**协调层**：`AcpBackendAdapter`（acp-backend-adapter.mjs）
- `ensureCoordinatorSession`：coordinator Session 按 owner+protocol 单例，落到
  SessionRegistry（JSON 文件持久化 sessionId + cwd），下次 `session/resume` 续接
- `coordinatorTurn`：构造 prompt（envelope + 用户偏好 + memory + 最近语音上下文 + 工作上下文），
  发给 backend Agent，解析返回的结构化 JSON
- **串行化双保险**：Gateway 队列 + `KeyedSerialExecutor`（按 owner 键串行），
  防止一个 Session 内并发消息竞态
- **委派（delegation）**：backend Agent 调用 `session_start` 后返回 `state=delegated`，
  adapter 立即释放协调锁，让其他请求继续；等待目标 Session 完成后再二次协调生成最终 presentation

**协调器 prompt**：`Coordinator`（coordinator.mjs）
- 把用户原话（final_asr）+ 客观目标（objective）包进 JSON envelope
- 明确要求 backend Agent 返回 `{"work_id":..., "state":"completed", "presentation":{"speech":"..."}}`
- 状态机校验：非 `completed` 状态会触发重试（最多 2 次）

**后端驱动**：`server/src/agent/backends/*.mjs`
- 每个 agent 一个 driver，声明 `id / label / capabilities`（delegation、permissions、
  externalMcp、sessionMcp 等布尔能力）
- `createProfile()` 返回 `acpConnection`（command/args/cwd/env）
- 例：Codex 通过 `scripts/codex-acp.mjs`（封装 `@agentclientprotocol/codex-acp` 包，
  自动探测 codex CLI / codex-acp binary / npx 回退）桥接成 ACP
- OpenClaw 走「内置 ACP bridge」；OpenCode/Qwen Code/Kimi Code 原生支持 ACP

### 3. 桌面端实现（`desktop/src/`）

**Electron 主进程**（main.mjs，约 1000 行）
- 浮动 orb 窗口：`transparent + frame:false + alwaysOnTop + skipTaskbar`，
  尺寸约 `DESKTOP_ORB_WIDTH x DESKTOP_ORB_HEIGHT`，可拖动（ipcMain 处理 drag-start/move/end）
- **内嵌 Gateway**：`EmbeddedGateway`（gateway-process.mjs）用 Electron
  `utilityProcess.fork` 启动 `server/src/index.mjs`，通过 `qwen-audio-agent:gateway-ready`
  消息 + origin 确认就绪；端口被占用时回退随机端口；崩溃自动重启（最多 3 次）
- Tray 图标 + 全局快捷键（globalShortcut）唤醒 + 自动休眠（SleepController）+ 本地唤醒词
- 设置窗口（settings.html/js）：backend Agent 选择/一键安装/配置、Realtime 模型、皮肤
- **安全边界**：renderer 走私有随机 loopback 路径，只代理 Gateway HTTP/WS；
  `contextIsolation + sandbox + nodeIntegration:false`；权限只对 media 类型放行
- 数据目录与 CLI 隔离（`app.setName` + 独立 `QWAUDIO_CONFIG_DIR`）

### 4. speech-to-speech 现状（改造基础）

- **核心**：Python 语音引擎，四段线程化管线 `VAD(Silero) → STT → LLM → TTS`，
  每阶段独立线程 + queue 连接，约 17k 行（`src/speech_to_speech/`）
- **对外**：OpenAI Realtime API 兼容 server（WebSocket `ws://host:port/v1/realtime` + WebRTC），
  `uvicorn` 运行，PipelineUnit 池管理多会话
- **LLM 工具调用**：已有完整闭环（`LLM/tool_call/`、`RealtimeFunctionTool`、
  `response.function_call.arguments.done` / `conversation.item.create(tool output)`）
- **唤醒词 + 声纹**：已实现（`security/`，sherpa-onnx KWS + ERes2NetV2 voiceprint）
- **demo/**：浏览器前端（index.html + main.js 67KB + server.py + s2s-realtime-client.js），
  基于 `@openai/agents` 的 RealtimeSession adapter
- **缺失**：ACP 集成（驱动 coding agent）、桌面端（Electron orb）、任务队列/Work 状态机

### 5. ACP Python SDK 调研（关键选型依据）

- 官方 Python SDK 存在：PyPI 包 **`agent-client-protocol`**，导入名 `acp`
- 提供 Pydantic 模型 + async 基类 + JSON-RPC 2.0 over stdio 的 plumbing
- 可同时构建 agent 端和 client 端
- 处于早期（v0.0.x），API 可能变动
- 生态：OpenCode 原生 ACP；Codex 有 `agentclientprotocol/codex-acp`（Node）适配器；
  也有 VS Code ACP client 扩展
- **结论**：Gateway 可以用 Python 实现（FastAPI + uvicorn，与 speech-to-speech 同栈）；
  coding agent 始终作为独立子进程被 spawn（stdio 通信），这是 ACP/RPC 的标准传输方式，
  与 Gateway 用什么语言无关。

### 6. pi 与 codex 的接入方式调研（新增）

**pi（当前环境）**：
- 原生 `pi --mode rpc`：JSONL over stdin/stdout，命令（prompt/steer/follow_up/abort/
  bash/new_session/set_model...）+ 事件流（message_update/tool_execution_*/agent_settled...）
- 官方文档 `docs/rpc.md` 提供**完整的 Python 客户端示例**（subprocess + JSONL 读写）
- 扩展 UI 子协议（extension_ui_request/response）支持 select/confirm/input（可做权限确认）
- **pi 的 ACP 支持是 experimental**（session server/client/protocol 标记实验性），
  第三方适配器 `@automatalabs/pi-acp` / `svkozak/pi-acp` 存在但 MCP 集成不完整
- **结论**：pi 用 `--mode rpc` 接入最稳，不走 ACP

**Codex**：
- 官方 `agentclientprotocol/codex-acp`（Node 包）实现 ACP server，stdio 通信
- 支持 client-provided MCP、slash commands
- **结论**：codex 走 ACP（Gateway 只需 spawn `codex-acp` 子进程）

**统一策略**：Gateway 内做 `AgentAdapter` 抽象，背后两个实现：
`PiRpcAdapter`（pi --mode rpc，JSONL）和 `CodexAcpAdapter`（codex-acp，ACP JSON-RPC）。
两者对上层暴露统一的 `submit(prompt) / status() / cancel() / events()` 接口。

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **Gateway 用 Python 实现，作为独立服务**（FastAPI + uvicorn） | 与 speech-to-speech 同栈；用户明确要求 Gateway 分层形式而非进程内集成；Python 完全可实现 |
| Gateway 暴露 HTTP + WebSocket 接口，speech-to-speech 引擎通过 `spawn_agent_task` 工具（HTTP 调用 Gateway）驱动 agent | 分层清晰：语音引擎只加一个工具；agent 编排/队列/协议全在 Gateway；两个服务独立部署 |
| **pi 走 `pi --mode rpc`，codex 走 ACP**（Gateway 内做 `AgentAdapter` 抽象） | pi 的 ACP 是 experimental，RPC 最稳且文档有 Python 示例；codex 官方 ACP 成熟；统一上层接口 |
| 桌面端用 Electron 壳 + 内嵌启动 Gateway（Gateway 再连语音引擎） | 与 qwen EmbeddedGateway 思路一致；桌面端是 Gateway 的客户端 |
| **桌面端用 TypeScript 开发**（非 qwen 的 .mjs） | 用户明确要求；类型安全，便于维护（2026-08-18 确认） |
| 复用已有唤醒词/声纹作为桌面休眠唤醒 | 已实现且测试通过，无需重写 |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| `python` 命令不存在（session-catchup 脚本失败） | 改用 `python3` 运行，无输出（无历史会话） |
| ACP Python SDK 早期版本风险 | 规划中锁定具体版本 + 抽象 Adapter 接口隔离 SDK 变动 |

## Resources

- qwen-audio-agent 仓库：`/Users/lzh/Documents/work/qwen-audio-agent`
- qwen 架构文档：`docs/architecture.md`（11 条架构不变量，极重要）
- ACP 传输客户端：`server/src/agent/acp-process-client.mjs`
- ACP 协调适配器：`server/src/agent/acp-backend-adapter.mjs`
- 协调器 prompt：`server/src/agent/coordinator.mjs`
- 后端驱动注册表：`server/src/agent/backends/registry.mjs` + `backends/codex.mjs`
- Codex ACP 适配器：`scripts/codex-acp.mjs`
- 桌面主进程：`desktop/src/main.mjs`、`desktop/src/gateway-process.mjs`
- 唤醒词工程文档：`docs/promo/articles/wake-word-engineering.md`
- speech-to-speech 架构文档：`docs/architecture.md`
- speech-to-speech 唤醒词：`src/speech_to_speech/security/wake_word.py`
- ACP Python SDK：https://agentclientprotocol.com/libraries/python 、
  https://github.com/agentclientprotocol/python-sdk
- ACP 规范：https://agentclientprotocol.com
- Codex ACP 适配器：https://github.com/agentclientprotocol/codex-acp
