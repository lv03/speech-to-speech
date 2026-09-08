### Task 7：RuntimeManager 和应用生命周期

**Files**

- Create: `desktop/src/main/runtime-manager.ts`
- Modify: `desktop/src/main/index.ts`, `desktop/src/main/qmd-service.ts`, `desktop/src/main/qmd-runtime.ts`, `desktop/src/main/model-store.ts`
- Modify: `desktop/src/main/gateway-process.ts`, `desktop/src/main/voice-process.ts`, `desktop/src/main/python-runtime.ts`
- Modify: `desktop/src/preload/index.ts`, `desktop/src/renderer/settings.html`, `desktop/src/renderer/settings.ts`
- Test: `desktop/tests/runtime-manager.test.mjs`, `desktop/tests/lifecycle.test.mjs`

**Interface**

```typescript
export class RuntimeManager {
  snapshot(): Promise<KnowledgeSnapshot>
  modelStatus(): Promise<KnowledgeModelStatus>
  subscribe(listener: (snapshot: PublicKnowledgeSnapshot) => void): () => void
  restoreExistingIndexes(): Promise<void>
  addCollection(root: string): Promise<CollectionRecord>
  removeCollection(collectionId: string): Promise<void>
  reindex(collectionId: string, confirmed: boolean): Promise<void>
  deleteIndex(collectionId: string): Promise<void>
  cancel(): void
  consentAndPrepare(collectionId: string): Promise<void>
  retry(): Promise<void>
  stop(): Promise<void>
}
```

`RuntimeManager` 是生产 IPC 的唯一业务入口：`restoreExistingIndexes()` 在 app 启动时只恢复已有索引，禁止下载模型或启动索引写操作；`addCollection()` 只保存规范化目录和待处理 collection，目录选择不启动 daemon、不运行 `collection add`，也不下载模型。`reindex()` 在 `needs_consent` 时必须要求 `confirmed === true`，随后由 `consentAndPrepare()` 按 `ModelStore -> QmdRuntime -> QmdIndexer -> ready_vec/indexing` 顺序执行。单个 collection 完成后只有在所有 enabled collection 都为 `ready` 时才能发布 `ready_vec`；仍有 pending/indexing collection 时必须保持 `indexing`。`modelStatus()` 返回 manifest 中的下载大小、已完成字节数、最终占用空间和取消/失败状态；禁止使用固定的 `0` 字节 provider。

`restoreExistingIndexes()` 由 `app.whenReady()` 在注册 IPC、创建 proxy 后调用一次，并在启动 voice 前完成首次尝试。它必须是幂等的：若全部 enabled collection 为 ready 且模型文件通过校验，则执行 `QmdRuntime.start()`、绑定 client、`initialize()`、`status()` 和每个 collection 的 vec query；若无 collection、模型缺失或存在 pending/failed collection，则不启动 QMD。恢复失败只发布 `degraded` 并保留手动 `retry()`，不能让未就绪的 QMD 阻塞 Gateway/Voice 的安全启动。

接口实现必须满足以下一致性约束：

1. `snapshot()` 只返回当前内部快照，不在 `reconcileState()` 内递归调用自己；发布由 `publishPublicSnapshot()` 单独完成。`subscribe()` 的参数和返回事件固定使用 `PublicKnowledgeSnapshot`，内部 `KnowledgeSnapshot` 不跨 IPC 边界。
2. `ModelStore.inspect()` 返回 `{ present, bytes, partialBytes, sha256 }`；`RuntimeManager` 保存 `completedBytes`，并把 ModelStore 的 progress callback 转成 live snapshot。下载、安装、索引和 embed 共用一个 exclusive operation；确认检查也必须位于同一 operation guard 内，第二个操作必须得到稳定的 `operation_in_progress` 错误，不能先通过 `modelStatus()` 再在后面才失败。
3. `QmdRuntime` 提供 child exit 订阅。unexpected exit 或 watchdog health failure 先调用 `QmdMcpClient.reset()`、清空 `QmdService` client/handles 和 `QmdProxy` 的 issued-handle allowlist、发布 `degraded`，再按 `1s -> 2s -> 4s` 退避恢复。恢复成功必须重新执行 `initialize -> status -> 每个 enabled ready collection 的受控 vec query`，失败三次后停止自动重试并保留手动 `retry()`；没有 collection、正在 stopping、用户取消或仍在启动恢复时不得自动拉起第二个 daemon。
4. 模型校验/安装错误进入 `failed`，daemon/MCP 错误进入 `degraded`，取消进入 `needs_consent`；错误原因只能通过脱敏的 `reason` 给 renderer，不能带路径、命令行、URL、堆栈或 token。
5. IPC 适配器把内部 `KnowledgeSnapshot` 转成只包含 `state`、`model` 和 public collection (`collectionId`、`displayName`、`directory`、`indexState`、`lastIndexedAt`) 的 `PublicKnowledgeSnapshot`。collection metadata、模型进度或索引状态更新不重启 voice，只有 proxy endpoint/token 变化才重启。preload 只实现 `onKnowledgeSnapshot` 一个订阅方法。退出测试必须观察到 voice、proxy、QMD、gateway 的顺序。

测试必须先写出并验证失败的以下场景，再实现：无 collection 时 `ModelStore.ensure`、`QmdRuntime.start` 和下载回调均不发生；已有 ready collection 启动恢复只调用 `start/initialize/status/query`，不调用下载和 indexer；缺少模型或 pending collection 启动不自动下载/索引；`.part` 下载过程中 snapshot 的 `completedBytes` 单调增加；用户取消保留 `.part` 且不启动 QMD；非 `206`/错误 `Content-Range` 的续传失败并清理 `.part`；带 Range 返回 HTTP 200 也必须失败并清理 `.part`；QMD child 意外退出立即发布 `degraded`、清空旧 handle 并按三次退避恢复；三次恢复失败后不再无限重启；恢复成功重新 initialize/status/query；第二个 collection 未 ready 时不提前发布 `ready_vec`；MCP 初始化失败清理 client/session/handle 并停止 daemon；QMD 私有目录/文件权限满足 `0700/0600`（包括既有文件）；非 loopback MCP endpoint 被拒绝；非预期事件清空 proxy allowlist；`subscribe()` 只收到 public 字段；renderer 收到 live snapshot 后不需要定时轮询；preload 不暴露重复 snapshot 订阅；voice/gateway/voiceprint 使用同一个 packaged PythonRuntime；退出顺序即使某个 stop 失败仍保持完整。

**跨 Task 执行顺序和提交门槛**

每个 Task 都必须独立完成“失败测试 -> 最小实现 -> focused 验收 -> 独立提交”。已有工作树改动可以作为实现素材，但不能替代下面的行为测试，也不能把本地 mock 结果写成发布验收结果。不得 amend、squash、rebase-rewrite 或 force-push 已存在的提交。

1. **Task 1-2：先固定 Python 工具加载器和 packaged runtime 契约。** 先写重复工具名、空模块、缺少 packaged Python、ABI 不匹配和 wheel manifest 校验失败测试，再实现加载器、PythonRuntime 和 manifest builder。验证：

   ```bash
   PYTHONPATH=.:src ./.venv/bin/python -m pytest -q \
     tests/openai_realtime/test_audio_client.py tests/test_cli_defaults.py
   npm --prefix desktop run typecheck
   npx --prefix desktop vitest run tests/python-runtime.test.mjs tests/build-runtime-manifest.test.mjs
   ```

2. **Task 3：固定 QMD 资源、模型下载和 CLI 生命周期。** 先写 resource dependency closure、无 collection 不启动、Range `200` 拒绝、非法 `Content-Range` 清理、取消保留 `.part`、既有宽权限修复以及 child `error` 立即失败测试，再实现。特别要验证 `QmdRuntime.start()` 和 `QmdIndexer` 的 spawn failure 都立即结束，不等待 timeout：

   ```bash
   npx --prefix desktop vitest run \
     tests/prepare-qmd-resources.test.mjs tests/model-store.test.mjs \
     tests/qmd-runtime.test.mjs tests/qmd-indexer.test.mjs
   npm --prefix desktop run typecheck
   ```

3. **Task 4-5：固定 service/proxy 合约和设置页 IPC。** 先写 SSE 无 session header、只允许 query/get/status、realpath/符号链接/opaque handle、body/响应截断、token 不出 renderer、safeStorage 损坏迁移和单一 snapshot 订阅测试，再实现 QmdService、QmdProxy、SecretStore 和设置页。IPC 测试的依赖必须是 RuntimeManager 形状的 fake，不能让生产 IPC 绕过 RuntimeManager：

   ```bash
   npx --prefix desktop vitest run \
     tests/qmd-mcp-client.test.mjs tests/qmd-service.test.mjs \
     tests/qmd-proxy-contract.test.mjs tests/settings-secrets.test.mjs \
     tests/knowledge-ipc.test.mjs
   npm --prefix desktop run typecheck
   ```

4. **Task 6：固定 Python 侧安全契约。** 先写 proxy URL 校验、稳定错误码、超时/取消、结果字段白名单、工具参数中无 path/docid/shell，以及恶意 Markdown 只能作为资料的测试，再实现 `qmd_knowledge.py`、提示词和 voice 环境注入：

   ```bash
   PYTHONPATH=.:src ./.venv/bin/python -m pytest -q \
     tests/test_qmd_knowledge.py tests/test_language_prompt.py
   node --test desktop/tests/voice-process-tools.test.mjs
   npm --prefix desktop run typecheck
   ```

5. **Task 7：在所有依赖完成后接 RuntimeManager。** 先写无 collection 零下载、首次确认在 exclusive guard 内、并发返回 `operation_in_progress`、多 collection 聚合、启动恢复不写索引、模型进度 live snapshot、daemon 崩溃立即降级和三次退避、恢复重握手、句柄清理以及退出顺序测试，再接入 `app.whenReady()` / `will-quit`：

   ```bash
   npx --prefix desktop vitest run \
     tests/runtime-manager.test.mjs tests/lifecycle.test.mjs \
     tests/model-store.test.mjs tests/qmd-runtime.test.mjs
   npm --prefix desktop run typecheck
   ```

6. **Task 8：最后执行真实 macOS arm64 gate。** 只有 standalone Python、锁定 wheelhouse、QMD native resource 和真实 embedding model 都有可验证 SHA-256 时才构建安装包。清洁机验证必须从临时 fixture 和临时 userData 开始，并清空 PATH、移出仓库和 `.venv`；缺资产时 job 失败或跳过均不能标记 v1 通过：

   ```bash
   npm --prefix desktop run dist:mac
   npm --prefix desktop run verify:package -- \
     --fixture "$RUNNER_TEMP/kb-zh" --data-root "$RUNNER_TEMP/s2s-data"
   ```

每个 Task 的提交前最低检查为 `git diff --check`、新增文件/构建产物扫描和敏感信息扫描。最终交付还必须通过第 8 节的完整矩阵。

**验收**

```bash
npx --prefix desktop vitest run tests/runtime-manager.test.mjs tests/lifecycle.test.mjs
npm --prefix desktop run typecheck
```

