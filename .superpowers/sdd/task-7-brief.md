### Task 7：RuntimeManager 和应用生命周期

**Files**

- Create: `desktop/src/main/runtime-manager.ts`
- Modify: `desktop/src/main/index.ts`, `desktop/src/main/qmd-service.ts`, `desktop/src/main/gateway-process.ts`, `desktop/src/main/voice-process.ts`
- Modify: `desktop/src/renderer/settings.html`, `desktop/src/renderer/settings.ts`
- Test: `desktop/tests/runtime-manager.test.mjs`, `desktop/tests/lifecycle.test.mjs`

**Interface**

```typescript
export class RuntimeManager {
  snapshot(): Promise<KnowledgeSnapshot>
  subscribe(listener: (snapshot: KnowledgeSnapshot) => void): () => void
  consentAndPrepare(collectionId: string): Promise<void>
  retry(): Promise<void>
  stop(): Promise<void>
}
```

实现无 collection 零模型下载，显式同意后按 `ModelStore -> QmdRuntime -> QmdIndexer -> ready_vec` 顺序执行；下载/安装/index/embed 单写者串行。daemon 崩溃按 1s、2s、4s 退避，连续 3 次进入 degraded；voice 不因 collection metadata 或索引状态更新而重启。退出测试必须观察到 voice、proxy、QMD、gateway 的顺序。

**验收**

```bash
npm --prefix desktop test -- tests/runtime-manager.test.mjs tests/lifecycle.test.mjs
npm --prefix desktop run typecheck
```

