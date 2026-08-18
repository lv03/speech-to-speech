# Task Plan: speech-to-speech 桌面端 + Gateway 驱动 coding agent（确定性方案）

> 参考实现：qwen-audio-agent（`/Users/lzh/Documents/work/qwen-audio-agent`）
> 改造对象：huggingface/speech-to-speech（当前目录）
> 方案版本：v2（2026-08-18，用户确认要 Gateway 分层 + Python 实现 + pi/codex 后端）

## Goal

为 speech-to-speech 增加「Electron 桌面悬浮球 + 独立 Python Gateway 服务」，Gateway 通过
子进程协议驱动 coding agent（**pi 走 `--mode rpc`、Codex 走 ACP**）执行任务，语音结果回传。

## 确定性架构（已定，非待选）

```
┌────────────────────────────────────────────────────────┐
│ Desktop（Electron 悬浮球 + 托盘 + 全局快捷键 + 唤醒词）    │
└────────────────────────┬───────────────────────────────┘
                         │ WebSocket + HTTP（本地）
┌────────────────────────▼───────────────────────────────┐
│ Agent Gateway（独立 Python 服务，FastAPI + uvicorn）★新增 │
│  ├─ 任务队列 + Work 状态机（queued→running→completed/…）  │
│  ├─ AgentAdapter 抽象                                    │
│  │   ├─ PiRpcAdapter    → spawn `pi --mode rpc`(JSONL)  │
│  │   └─ CodexAcpAdapter → spawn `codex-acp`(ACP)        │
│  ├─ 权限/进度投影（脱敏事件流）                            │
│  └─ 接口：POST /tasks · GET /tasks/{id} · DELETE cancel  │
│          · WS /events（进度/结果流）                      │
└──────┬──────────────────────────────────────┬───────────┘
       │ HTTP（工具回调）                       │ stdio 子进程
┌──────▼─────────────────────────┐   ┌─────────▼─────────┐
│ speech-to-speech 引擎（已有）    │   │ coding agent       │
│  VAD→STT→LLM→TTS               │   │  • pi (rpc)        │
│  LLM 工具: spawn_agent_task    │   │  • codex (acp)     │
│  （新增，HTTP 调 Gateway）      │   └───────────────────┘
└────────────────────────────────┘
```

**分层职责（明确边界）**：
- **语音引擎**：只做语音（VAD/STT/LLM/TTS），通过新增的 `spawn_agent_task` 工具把
  「需要 coding agent 干的事」丢给 Gateway。改动极小。
- **Agent Gateway**：独立进程，职责单一 —— agent 编排、任务队列、协议适配（pi RPC / codex ACP）、
  权限与进度投影。不碰语音。
- **Desktop**：Gateway 的客户端（悬浮球 UI），内嵌启动 Gateway。

## Current Phase

Phase 3（桌面端 Electron floating orb）

## Phases

### Phase 0: 方案确定 ✅
- [x] 深度分析 qwen-audio-agent（架构 / ACP / 桌面端 / 唤醒词）
- [x] 调研 speech-to-speech 现状
- [x] 调研 pi 接入（`--mode rpc`，JSONL，有 Python 示例）与 codex 接入（`codex-acp`，ACP）
- [x] 确定 Gateway 分层架构（Python + 独立服务）
- [ ] **用户最终确认本方案** → 进入 Phase 1
- **Status:** in_progress

### Phase 1: Agent Gateway 服务（核心，独立 Python 服务）✅
> 目标：一个能 spawn pi/codex 子进程、管理任务队列的独立服务。

- [x] 1.1 新建 `gateway/` 目录（独立 Python 包，复用主项目 venv 的 fastapi/uvicorn/httpx）
- [x] 1.2 `agent_adapter/` 抽象层：
  - `base.py` —— 统一接口 `run(task_id, prompt, on_event, cancel_event)`
  - `pi_rpc.py` —— spawn `pi --mode rpc`，JSONL 读写（已冒烟验证：真实 pi 返回“测试成功”）
  - `codex_acp.py` —— spawn `codex-acp`（ACP JSON-RPC，⚠️ codex 未装，需后续联调）
- [x] 1.3 `task_queue.py` —— Work 状态机（queued/running/completed/failed/cancelling/cancelled）+ JSON 持久化
- [x] 1.4 进度/结果事件流（WS `/events`，事件广播 pub/sub，脱敏）
- [x] 1.5 HTTP 接口：POST/GET/DELETE /tasks、GET /health
- [x] 1.6 单元测试（15 个）+ 端到端验证（真实 gateway + 真实 pi，HTTP→pi→结果回传）
- **Status:** complete

### Phase 2: 语音引擎接入（spawn_agent_task 工具）✅
> 目标：语音 LLM 能通过工具把任务交给 Gateway。

- [x] 2.1 新建 `src/speech_to_speech/tools/agent_gateway.py`：TOOLS + `async execute_tool`，复用 local 模式的 `--tool-module` 服务端工具机制
- [x] 2.2 三个工具：`spawn_agent_task`（POST /tasks）、`get_agent_task_status`（GET）、`cancel_agent_task`（DELETE），均返回 JSON 字符串
- [x] 2.3 工具结果回传：返回 str → LLM 生成确认；CREATE_RESPONSE=True
- [x] 2.4 测试：7 单测（mock Gateway HTTP）+ load_realtime_tool_module 加载验证 + 真实 Gateway 集成（spawn→轮询→completed）
- **Status:** complete
- ⚠️ 已知边界：任务完成需 LLM 主动轮询 get_agent_task_status；“完成自动通知语音”需 Gateway→语音引擎推送机制（后续增强）

### Phase 3: 桌面端（Electron floating orb）
> 目标：可拖动悬浮球 + 设置窗口，内嵌启动 Gateway + 语音引擎。

- [x] 3.1 新建 `desktop/` Electron + TypeScript 工程（electron-vite，三端 TS）
- [x] 3.2 浮动 orb 窗口（transparent + frameless + alwaysOnTop + 可拖动）
- [x] 3.3 内嵌启动 Gateway（子进程 + Python 探测 + 就绪轮询 + 优雅关闭）
- [x] 3.4 orb 前端连 Gateway（WS /events 实时任务列表 + 派任务）
- [x] 3.5 托盘 + 菜单（显示/设置/退出）
- [x] 3.6 设置窗口（独立 BrowserWindow）：后端 Agent 类型、Gateway 端口、语音引擎开关、唤醒词开关/文本、**悬浮球皮肤**，JSON 持久化
- [x] 3.7 **自定义外观（Codex Pet 包兼容）**：扫描 ~/.codex/pets/ + 自有 skins 目录，skin:// 协议，sprite 帧动画（对齐 Codex App），状态→动画轨道映射，设置面板选择皮肤
- [x] 3.8 **内嵌启动 speech-to-speech 语音引擎**：spawn `speech-to-speech local` + `--tool-module agent_gateway` + `--enable_wake_word`，就绪探测，已实测（唤醒词锁定日志确认）
- [x] 3.9 **状态动画接通**：Gateway 任务状态 → working/idle 动画
- [x] 3.10 **全局快捷键 + 自动休眠**：可配置快捷键切换悬浮球显示/隐藏，空闲自动隐藏，用户活动重置倒计时
- **Status:** complete（核心 + 增强全部完成，仅剩第 2 项语音状态细化与 Codex 联调）

### Phase 4: 整合、测试与打包
- [ ] 4.1 全链路回归：语音 → spawn_agent_task → pi/codex 执行 → 结果语音回传
- [ ] 4.2 权限确认（pi 的 extension_ui / codex 的 permission）→ 语音/UI 确认
- [ ] 4.3 取消 / 进度 / 唤醒词 全链路测试
- [ ] 4.4 Electron 打包（electron-builder，macOS 优先）+ 文档
- **Status:** pending

## Key Questions（已答复）

1. ~~架构选型~~ → **Gateway 分层 + Python 实现**（用户确认）
2. ~~后端 agent~~ → **pi（rpc）+ codex（acp）**（用户确认）
3. ~~实施范围~~ → **先出确定性方案，暂不实施**（用户确认）
4. 待定：Gateway 与语音引擎是否**必须**分两个进程？（当前方案是分；若想简单，也可 Gateway 内嵌语音引擎为库）

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Gateway 独立 Python 服务 | 用户要 Gateway 分层；Python 与现有栈一致 |
| pi 走 RPC、codex 走 ACP | pi 的 ACP 实验性、RPC 最稳；codex ACP 成熟 |
| 语音引擎只加 spawn_agent_task 工具 | 最小改动，职责清晰 |
| AgentAdapter 统一接口 | 屏蔽 pi/codex 协议差异，便于扩展 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| `python: command not found` | 1 | 改用 `python3` |
| （无其他） | - | - |

## Notes

- 本方案是「确定性方案」交付物，Phase 1 起才开始写代码。
- pi RPC 协议细节见 `/Users/lzh/.nvm/.../pi-coding-agent/docs/rpc.md`（含 Python 客户端示例）。
- 参考代码路径见 findings.md Resources。
