# Agent Gateway

speech-to-speech 的独立 Agent 编排服务：通过子进程协议驱动 coding agent
（**pi** 走 `--mode rpc`、**Codex** 走 `codex-acp`）执行任务，供语音引擎与桌面端调用。

## 架构

```
speech-to-speech 引擎（LLM 工具 spawn_agent_task）
        │ HTTP POST /tasks
        ▼
Agent Gateway（本服务，独立进程）
        │ stdio 子进程
        ▼
coding agent（pi --mode rpc / codex-acp）
```

## 运行

复用主项目虚拟环境（fastapi / uvicorn / httpx 已在主依赖中）：

```bash
# 从仓库根目录
.venv/bin/python -m gateway
# 或
uv run python -m gateway
```

默认监听 `http://127.0.0.1:3101`。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `GATEWAY_HOST` | `127.0.0.1` | 监听地址 |
| `GATEWAY_PORT` | `3101` | 监听端口 |
| `GATEWAY_DEFAULT_KIND` | `pi` | 默认 agent 后端（`pi` / `codex`） |
| `GATEWAY_PI_BIN` | `pi` | pi 可执行文件路径 |
| `GATEWAY_PI_PROVIDER` | （pi 默认） | pi 的 LLM provider |
| `GATEWAY_PI_MODEL` | （pi 默认） | pi 的模型 |
| `GATEWAY_PI_SESSION_DIR` | （无） | pi session 存储目录 |
| `GATEWAY_PI_PERMISSION_POLICY` | `reject` | 无上层决策时权限兜底（`reject` / `confirm`） |
| `GATEWAY_CODEX_ACP_BIN` | （用 npx） | 已安装的 codex-acp 路径 |
| `GATEWAY_CODEX_ACP_PACKAGE` | `@agentclientprotocol/codex-acp` | npx 安装的 codex-acp 包 |
| `GATEWAY_PERSISTENCE` | （无） | 任务持久化 JSON 文件路径 |
| `GATEWAY_LOG_LEVEL` | `INFO` | 日志级别 |

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/tasks` | 创建任务，body `{"prompt": "...", "kind": "pi"}`（kind 可选） |
| `GET` | `/tasks` | 任务列表 |
| `GET` | `/tasks/{id}` | 任务详情 |
| `DELETE` | `/tasks/{id}` | 取消任务 |
| `GET` | `/health` | 健康检查 |
| `WS` | `/events` | 任务进度/结果事件流 |

### 事件格式

```json
{"task_id": "...", "event": "status", "data": {"status": "running", "task": {...}}}
{"task_id": "...", "event": "text_delta", "data": {"delta": "..."}}
{"task_id": "...", "event": "tool_start", "data": {"name": "bash"}}
{"task_id": "...", "event": "completed", "data": {"text": "..."}}
```

## 任务状态机

```
queued → running → completed
               ├→ failed
               └→ cancelling → cancelled
```

## 测试

```bash
.venv/bin/python -m pytest gateway/tests/ -q
```

## 已知边界

- **Codex 后端需联调**：当前环境未安装 Codex，`codex_acp.py` 基于 ACP 规范与
  qwen-audio-agent 实现推断，method 名与字段需装好 codex-acp 后验证。
- 每个任务 spawn 一个独立 agent 子进程（任务隔离），尚无跨任务的持久 session 复用。
- 权限请求（pi 的 extension_ui / codex 的 permission）当前按环境变量策略自动兜底，
  语音确认链路在后续阶段接入。
