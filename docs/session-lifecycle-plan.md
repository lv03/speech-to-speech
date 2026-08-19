# 首选①：加深 Realtime 会话生命周期模块 — 细化方案

> 对应架构审查报告 `candidate-session-lifecycle`（Strong / in-process）。
> 目标：把「claim/release/drain、取消/清队列策略、输出门控、usage salvage」
> 收敛到一个深模块接口后面，让 transport 路由不再知道队列、SESSION_END、
> 取消代际、response key 和 `RealtimeService._state`。

## 1. 现状 seam 泄漏清单

会话生命周期的正确性规则目前散在 `websocket_router.py`（1160 行）与
`pipeline_unit.py`，调用方（路由 + send loop）必须直接操纵内部状态。

| # | 泄漏点 | 位置 | 表现 |
|---|--------|------|------|
| L1 | `unit.session` 公开直接改 | `_claim_unit` / `_release_unit_after_drain` / WebRTC setup 错误路径 | 路由直接 `unit.session = SessionState(...)`、`unit.session = None` |
| L2 | `SessionState` 暴露 send-loop 草稿与生命周期计时 | `pipeline_unit.py` | `pending_output_item`、`pending_text_output_items`、`drained`(asyncio.Event)、`released_at`、`quarantined_at` 全公开 |
| L3 | `service._state(...)` 私有访问 | `_response_key_is_obsolete` / `_response_key_output_is_blocked` / `_discard_obsolete_response_key` / `_dispatch_client_event` / send loop（~10 处） | 路由绕过 service 公开接口读 `ConnState` |
| L4 | 队列拓扑 + flush 策略散落 | `_clean_unit` / `_flush_queue` / barge-in 两处重复的 preserve 谓词 | `_keep_cancel_bookkeeping`、`_keep_user_text_event`、`_keep_pipeline_control`、`_keep_non_audio_output` 是路由器模块级函数 |
| L5 | SESSION_END 排空机制 | `_release_session` / `_release_unit_after_drain` / send loop 收尾段 | 路由入队 `PipelineControlMessage(SESSION_END.kind, session_id=...)`，send loop 识别并 `session.drained.set()` |
| L6 | 取消代际 / CancelScope | send loop + `_dispatch_client_event` | `new_response()/cancel()/reset()/is_stale()/response_done()/generation/discarding` 全部裸露 |

**后果**：跨会话隔离、取消、队列保留、隐藏 prefetch 暴露、usage 记账这些
最高风险的正确性规则，都靠「路由别忘」来保证——任何新 transport（或新维护者）
都必须在多个文件里复刻同一套 flush/排空/门控逻辑。

## 2. 目标接口

让 `PipelineUnit` 成为深模块（数据字段转私有，生命周期通过方法暴露）。
transport 路由只看到：

```python
class PipelineUnit:
    # ── 会话生命周期（唯一对外 seam）───────────────────────────────
    def claim(self, transport: SessionTransport | None) -> bool:
        """原子认领（self._session is None 时）并创建会话。"""

    def register(self) -> str:
        """在 service 注册连接，返回 session_id。"""

    def reset(self) -> None:
        """连接建立后的防御性复位（原 _clean_unit：cancel+flush+清事件）。"""

    async def dispatch_client_event(
        self, raw: dict, transport: SessionTransport, *, transport_kind: str
    ) -> None:
        """解析并应用一个客户端事件（原 _dispatch_client_event + 输入入队）。"""

    def enqueue_input(self, chunk: Any, rt_cfg: Any) -> None:
        """音频/输入进入管线（WebSocket append 与 WebRTC track 共用）。"""

    def release(self, session_id: str) -> None:
        """断开后：标记 released → 清队列(usage salvage) → 入队 SESSION_END → 派发排空任务。"""

    async def run_send_loop(self, stop_event: ThreadingEvent) -> None:
        """输出泵：读队列 → 输出门控 → transport（原 _send_loop_for）。"""

    def pool_view(self, now: float) -> dict:
        """供 /v1/pool 的状态视图（idle/active/draining/stuck）。"""
```

路由端变成薄适配器：

```python
# websocket_router.py（重构后）
unit = next((u for u in pool if u.claim(transport)), None)
if unit is None:
    ...  # 503 / session_limit_reached
try:
    session_id = unit.register()
    await ws.send(...unit.service.build_session_created(session_id))  # 保留这层只读调用
    while ...:
        raw = await ws.receive_json()
        await unit.dispatch_client_event(raw, transport)
finally:
    unit.release(session_id)
```

## 3. 需要一并收敛的「私有状态访问」→ service 公开方法

L3 的 `service._state(...)` 不能只靠搬家掩盖。给 `RealtimeService` 补公开方法：

```python
# service.py 新增
def runtime_config(self, conn_id: str) -> RuntimeConfig        # 替代 _state(...).runtime_config
def response_key_is_obsolete(self, conn_id, key) -> bool      # 替代 _response_key_is_obsolete
def is_response_output_blocked(self, conn_id, key) -> bool    # 委托 response handler（已存在）
def discard_response_key(self, conn_id, key) -> None          # 替代 _discard_obsolete_response_key
```

> 注：这只是「读」的收敛。候选②（RuntimeConfig 快照）是更进一步的
> 可变性治理，不在本次范围，但本次加的这些方法会给②铺路。

## 4. 迁移步骤（每步保持测试绿）

**Phase A — 无行为变化的搬家（纯机械）**
1. `PipelineUnit` 字段改名 `_session`/私有（`session` 保留只读 property 供过渡期）。
2. 把 `_flush_queue`、`_clean_unit`、keep 谓词、`_claim_unit`、`_release_session`、
   `_release_unit_after_drain`、`_send_loop_for`、`_dispatch_client_event` 整体搬进
   `PipelineUnit` 方法（或新 `session_lifecycle.py` 模块 + `unit.session` 指向它）。
3. 路由改为调用新方法。**本阶段不改任何逻辑，只改归属**。
   - 验证：`pytest tests/openai_realtime/test_websocket_router.py`（1444 行测试应全绿）。

**Phase B — 收敛 service._state（L3）**
1. 加 `runtime_config` / `response_key_is_obsolete` / `discard_response_key` 公开方法。
2. 生命周期模块内不再出现 `_state`。
   - 验证：同上，测试绿 + 类型检查。

**Phase C — 收紧接口（L2/L6）**
1. `SessionState` 的 `pending_output_item`/`pending_text_output_items`/`drained`
   变为生命周期内部私有，`/v1/pool` 改走 `pool_view()`。
2. `cancel_scope` 的裸露操作收敛成 `cancel_active_response()` / `discard_if_stale()` 等方法。
3. 删掉路由里遗留的模块级 flush 谓词。
   - 验证：测试绿；新增针对 `pool_view()` / 生命周期方法的单测。

## 5. 风险与护栏

- **最大风险**：send loop 的时序语义（prefetch 输出门控、stale generation 丢弃、
  SESSION_END 排空、quarantine）极其精细。Phase A 必须是**纯搬家、零逻辑改动**，
  否则 1444 行测试里 `test_prefetched_output_waits_...`、`test_quarantine_*`、
  `test_stale_*` 系列会立刻抓出差错。
- **护栏**：现有 `tests/openai_realtime/test_websocket_router.py` 就是行为契约；
  每个 Phase 都以它 + `mypy`/`ruff` 全绿为验收门槛。
- **范围外**：候选②（RuntimeConfig 快照）、候选③（pipeline graph）不动。

## 6. 建议切入点

从 **Phase A** 开始，先跑通「搬家」并全绿，再逐 Phase 递进。单次提交应可独立 review。
