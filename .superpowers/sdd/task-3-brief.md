### Task 3：QMD 资源、索引命令和模型资产

**Files**

- Create: `desktop/scripts/prepare-qmd-resources.mjs`, `desktop/src/main/model-store.ts`, `desktop/src/main/qmd-runtime.ts`, `desktop/src/main/qmd-indexer.ts`
- Modify: `desktop/package.json`, `desktop/electron-builder.yml`
- Test: `desktop/tests/prepare-qmd-resources.test.mjs`, `desktop/tests/model-store.test.mjs`, `desktop/tests/qmd-runtime.test.mjs`, `desktop/tests/qmd-indexer.test.mjs`

**Implementation**

`prepare-qmd-resources.mjs` 从 `package-lock.json` 对当前平台解析 `@tobilu/qmd@2.8.3` 的 `dependencies + optionalDependencies` 闭包，保留嵌套版本和当前平台 native 包，排除 Electron、Vitest、其他平台包和 dev dependency。QMD 的实际入口是 `node_modules/@tobilu/qmd/bin/qmd`，不能假设存在 `qmd.js`。

`QmdRuntime` 用 Electron 自带 `process.execPath`、`ELECTRON_RUN_AS_NODE=1`、`--host ::1` 和随机端口启动 daemon；`ModelStore` 将 GGUF 下载到 `.part`，支持 Range 续传、取消保留 partial、SHA-256/size 校验和原子 rename。校验后将模型放入 `<userData>/qmd/cache/qmd/models/`，再把绝对路径写入 app-private `index.yml`。发布路径禁止让 QMD 自己按 `hf:` URI 下载。

`QmdIndexer` 只允许固定命令和固定参数：`collection add <canonicalRoot> --name <generatedName> --mask **/*.md`、`collection remove <generatedName>`、`update`、`embed` 和 `embed --force`。它必须固定 `INDEX_PATH`、`HOME`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME`，丢弃或脱敏 stdout/stderr，不接受 renderer、Python 或模型传入的命令。

**验收**

```bash
npm --prefix desktop test -- tests/prepare-qmd-resources.test.mjs \
  tests/model-store.test.mjs tests/qmd-runtime.test.mjs tests/qmd-indexer.test.mjs
npm --prefix desktop run typecheck
npm --prefix desktop run prepare:qmd
```

