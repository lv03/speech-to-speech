### Task 5：SecretStore、IPC 和知识库设置页

**Files**

- Create: `desktop/src/main/secret-store.ts`
- Modify: `desktop/src/main/settings.ts`, `desktop/src/main/index.ts`, `desktop/src/preload/index.ts`
- Modify: `desktop/src/renderer/settings.html`, `desktop/src/renderer/settings.ts`, `desktop/src/renderer/settings.css`
- Test: `desktop/tests/settings-secrets.test.mjs`, `desktop/tests/knowledge-ipc.test.mjs`

**Implementation**

renderer 可看到用户选择的 collection displayName、规范化目录、模型下载大小、占用空间和状态，但不可看到 token、QMD docid 或 QMD 内部路径，也不可看到 key 明文。目录选择使用 Electron dialog；所有 IPC 入参重新做类型和权限校验，不能相信 renderer 传入的 collection name。

设置页必须提供添加/移除目录、重新索引、取消、删除索引和失败重试，并明确“删除索引不会删除原文件”。首次下载必须是可取消的显式确认流程。

**验收**

```bash
npm --prefix desktop run typecheck
npm --prefix desktop test -- tests/settings-secrets.test.mjs tests/knowledge-ipc.test.mjs
```

