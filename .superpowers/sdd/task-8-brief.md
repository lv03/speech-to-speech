### Task 8：真实 QMD、干净安装包和发布门槛

**Files**

- Create: `desktop/scripts/verify-package.mjs`
- Create: `desktop/tests/fixtures/kb-zh/allergy.md`, `desktop/tests/fixtures/kb-zh/project-notes.md`, `desktop/tests/fixtures/kb-zh/malicious-instructions.md`
- Modify: `.github/workflows/ci.yml`, `desktop/README.md`

**验收步骤**

```bash
npm --prefix desktop run dist:mac
```

从临时安装位置运行 `verify-package.mjs`，移走仓库、`.venv`、系统 Node/npm 和 PATH 依赖，完成真实 fixture 的 `collection add -> update -> embed -> status -> vec query -> get`，再通过语音工具完成 search/get。只验证 `qmd --version` 不算通过。

必须通过以下矩阵：

| 类别 | 必测行为 |
|---|---|
| 安装 | 无系统 Python/Node/npm/仓库仍可运行；QMD native `.node` 可加载 |
| 资产 | 中断恢复、取消、SHA/size 失败清理、网络失败、磁盘不足 |
| 生命周期 | 无 collection 零下载；端口冲突；daemon 崩溃重试；voice/gateway 退出清理 |
| 隔离 | app-private HOME/XDG/INDEX_PATH；全局 QMD 配置和缓存不变化 |
| 安全 | 未授权 route、路径穿越、NUL、符号链接、未知/过期 handle、恶意 Markdown |
| 隐私 | key 不进 JSON/IPC/args/log/tool output；远程 LLM 出网提示正确 |
| 质量 | 真实中文 Top-1/Top-3、无答案误召回、热查询 P50/P95 |

发布硬门槛：macOS arm64 热查询 P95 `<=300ms`；记录冷启动加载时间、QMD/voice RSS、下载和磁盘占用；完成依赖许可证清单；v1 runtime 不含 VoiceMem 和默认记忆工具；签名/公证策略通过发布检查。

所有实现任务完成后的统一提交前检查为：

```bash
npm --prefix desktop run typecheck
npm --prefix desktop test
PYTHONPATH=.:src ./.venv/bin/python -m pytest -q
```

其中 `npm --prefix desktop test` 已固定为 Vitest 与 Node `--test` 的分流入口；三条命令都通过后，才进入真实安装包验收，不以单个 focused test 替代全量检查。

## 9. VoiceMem 后置路线

Phase 5 只有 Phase 4 通过后才开始，独立 venv/进程、独立 runtime profile 和独立验收。当前调研显示 VoiceMem 0.2.3 依赖重、API 演进快，中文 ingest 的事实抽取需要 OpenAI-compatible key，不能宣称纯本地离线。开始前必须：

1. 固定 VoiceMem 版本并通过 torch、STT、音频设备冲突测试。
2. 以 `ingest_final_turn()`、`recall()`、`delete_all()` 三个适配器接口隔离外部 API。
3. 只消费最终转写，按 `(turn_id, turn_revision)` 去重。
4. 未解锁或声纹未启用时禁止读写记忆；声纹不能被描述为身份认证。
5. 明确单条删除、纠错、过期、来源、时间戳、置信度和云端抽取同意。
6. 使用完整中文 ingest/search 回归；安装成功不等于功能通过。

VoiceMem 失败不能阻塞 KB v1，也不能进入 v1 Python runtime、默认工具列表或发布依赖。

## 10. 风险与决策门

| 风险 | 等级 | 决策 |
|---|---|---|
| Python runtime 无法脱离仓库 | 阻塞 | Phase 0 不通过则停止发布化实施 |
| QMD native 包在 Electron 中不可用 | 阻塞 | 必须完成真实 embed/query/get，不接受 version smoke test |
| QMD HTTP 协议变化 | 高 | 固定 2.8.3；SSE parser + allowlist contract test |
| 全局 QMD 数据污染 | 阻塞 | app-private env 和写入路径测试不通过即停止 |
| 任意文件读取/handle 越权 | 阻塞 | realpath + collection root + opaque handle 测试不通过即停止 |
| 中文 BM25 不可用 | 中 | v1 使用 vec-only；无 embedding 返回未就绪 |
| QMD 热 RSS 约 1 GB | 高 | 显式下载、资源提示、RSS 门槛和懒启动 |
| Python 依赖体积/平台差异 | 高 | CI profile + 锁定 wheelhouse + 干净机验证 |
| API key 泄露 | 高 | safeStorage、IPC 分离、日志脱敏和迁移测试 |
| VoiceMem 依赖/云端抽取未闭环 | 高 | 排除 v1，Phase 5 独立验收 |

## 11. 完成定义

只有下面陈述全部成立，才称为 v1 完成：

> 用户在没有系统 Python、Node、npm 和仓库目录的 macOS arm64 机器上安装应用，选择 Markdown vault 并明确同意模型下载后，应用在 app-private 目录完成向量索引；语音助手通过受限工具回答真实中文问题并给出来源；工具不能读取 vault 外文件，不能被 Markdown 指令诱导越权；QMD、voice、gateway 任一进程失败时应用显示准确状态并能安全退出。

VoiceMem 不属于上述完成定义。

## 12. 文件变更总表

```text
desktop/src/main/runtime-types.ts        runtime、collection、IPC 类型
desktop/src/main/python-runtime.ts       发布 Python 和 wheelhouse
desktop/src/main/model-store.ts          资产下载、恢复、校验、安装
desktop/src/main/qmd-runtime.ts          QMD daemon 生命周期
desktop/src/main/qmd-indexer.ts          受限 QMD collection/update/embed/remove 命令
desktop/src/main/qmd-mcp-client.ts      QMD MCP/SSE adapter
desktop/src/main/qmd-service.ts         collection、索引队列、handle 前置校验
desktop/src/main/qmd-proxy.ts           loopback JSON API、token、handle store
desktop/src/main/runtime-manager.ts     全局状态和生命周期
desktop/src/main/secret-store.ts        safeStorage 和旧 key 迁移
desktop/src/main/index.ts               IPC、启动/退出编排
desktop/src/main/gateway-process.ts     使用 PythonRuntime 的 gateway
desktop/src/main/voice-process.ts       使用 PythonRuntime、多工具和 proxy env
desktop/src/preload/index.ts            最小 IPC surface
desktop/src/renderer/settings.*         知识库、模型和状态 UI
desktop/scripts/build-runtime.mjs       CI runtime manifest
desktop/scripts/prepare-qmd-resources.mjs QMD 生产依赖闭包
desktop/scripts/verify-package.mjs     干净安装包验收
gateway/pyproject.toml                  独立 gateway wheel
src/speech_to_speech/tools/qmd_knowledge.py 受限 JSON 客户端
src/speech_to_speech/api/openai_realtime/audio_client.py 多工具加载器
tests/test_qmd_knowledge.py             Python 工具安全/错误测试
desktop/tests/*qmd*.test.mjs            QMD、proxy、handle 合约测试
desktop/tests/*lifecycle*.test.mjs      生命周期测试
```

## 13. 参考记录

- QMD 2.8.3、MCP HTTP、中文 vec-only/hybrid 对比和 RSS：`docs/research/phase0-qmd-voicemem-findings.md`
- 历史调研和早期方案：`docs/qmd-local-kb-plan.md`
- Realtime 工具契约：`src/speech_to_speech/api/openai_realtime/README.md`
- 当前桌面分发配置：`desktop/package.json`、`desktop/electron-builder.yml`
