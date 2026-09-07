# speech-to-speech Desktop

桌面悬浮球（Electron + TypeScript），内嵌启动 Agent Gateway，可给 coding agent
派任务，后续接入语音对话与唤醒词。

## 技术栈

- Electron 43 + TypeScript
- electron-vite 构建（main / preload / renderer 三端 TS）
- 主进程内嵌启动 app-private Python Gateway、Realtime voice 和受限 QMD 知识库

## 开发

```bash
cd desktop
npm install
npm run dev        # 热重载开发
npm run build      # 构建到 out/
npm run typecheck  # 类型检查
```

## 目录结构

```
desktop/
├── src/
│   ├── main/
│   │   ├── index.ts           # 主进程：窗口 + 托盘 + IPC + 启动 Gateway
│   │   └── gateway-process.ts # 内嵌 Gateway 子进程管理（使用 PythonRuntime 路径 + 就绪轮询）
│   ├── preload/
│   │   └── index.ts           # contextBridge 暴露 desktop API
│   └── renderer/
│       ├── index.html         # 悬浮球 + 任务面板
│       ├── orb.ts             # 前端逻辑（WS 事件 + 任务列表 + 派任务）
│       └── style.css
└── electron.vite.config.ts
```

## 开发环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `GATEWAY_PORT` | `3101` | Gateway 端口 |
| `VOICE_PORT` | `8765` | 语音引擎 Realtime 端口 |
| `GATEWAY_URL` | `http://127.0.0.1:3101` | 语音引擎工具模块访问的 Gateway 地址 |
| `RUNTIME_MANIFEST_PATH` | 无 | 开发模式显式指定 runtime manifest；发布模式从 `resources/runtime-manifest.json` 读取 |

开发模式可以通过显式 `devRoot` 使用仓库 `.venv`；发布模式不读取 `GATEWAY_ROOT`、`GATEWAY_PYTHON`、PATH 或仓库目录。知识库 QMD、Python runtime 和模型资产必须来自 manifest/资源目录，不能由 renderer 或语音进程自行安装。

## 当前状态（知识库 v1 实施校正）

- [x] 浮动 orb 窗口（透明无边框置顶，可拖动）
- [x] 托盘图标 + 菜单（显示悬浮球 / 设置… / 退出）
- [x] 内嵌启动 Gateway + 就绪探测
- [x] orb 前端：Gateway 状态 + 任务列表 + 派任务（WS /events 实时刷新）
- [x] 设置窗口：后端 Agent 类型、Gateway 端口、语音引擎开关、唤醒词开关/文本、悬浮球皮肤
- [x] **自定义外观**：兼容 Awesome Codex Pet 宠物包（pet.json + spritesheet.webp），扫描 `~/.codex/pets/` + 自己的 skins 目录，sprite 帧动画渲染，状态映射动画轨道（idle/working/attention…）
- [x] **内嵌启动 speech-to-speech 语音引擎**：spawn `speech-to-speech local`，挂工具模块（`agent_gateway,qmd_knowledge`）+ 唤醒词，就绪探测（stdout 启动完成消息）
- [x] **状态动画接通**：Gateway 任务状态 → working/idle；语音状态 → listening/thinking/speaking/idle（通过 local 模式 `--local_audio_print_json` 的 EVENT 事件解析）
- [x] **全局快捷键 + 自动休眠**：可配置唤醒快捷键（切换悬浮球显示/隐藏），空闲自动隐藏
- [x] **Electron 打包**：electron-builder（macOS 15+ zip/dmg；无凭据时本地可未签名，发布环境使用 Developer ID/公证凭据）
- [x] **本地知识库代码链路**：QMD 2.8.3、vec-only 检索、opaque docid、实时状态、Python 多工具和安全边界测试
- [ ] **发布 gate**：需要真实 macOS 15+ arm64 runtime bundle、签名 manifest 和干净安装包 smoke；通过前不宣称 v1 发布完成
- [x] **声纹注册 UI 入口**：设置窗口可查声纹状态（区分未注册 / 自然语音档案 / 旧版需重录）、注册（录多段自然语音，进度实时显示）、验证；启用后语音引擎加 `--enable_voiceprint`，并支持设置声纹阈值 `--voiceprint_threshold`

## 打包与发布验收

```bash
cd desktop
npm run dist:mac    # 需要真实 macOS 15+ arm64 runtime bundle 的 manifest/资源
```

发布包包含固定版本的 QMD 资源、native addon、standalone Python 和锁定 wheelhouse，但不内置 GGUF。应用只接受由固定公钥验证过的 Ed25519 manifest；用户明确同意后，应用才会从 manifest 的 HTTPS URL 下载 embedding 模型到 app-private `userData/runtime/models/<asset.id>-<asset.version>.gguf`，并在下载前校验大小和 SHA-256；QMD 的 config/cache/index 固定在 `userData/qmd/`。打包不会依赖用户安装 Node、npm、Python、QMD CLI 或仓库代码。真实发布 gate 由手动触发的 macOS 15+ arm64 CI 完成：它在空 PATH、临时 HOME、无仓库运行时的环境中，把同版本、同 SHA 的真实 smoke GGUF 预置到临时 userData，使用临时中文 fixture 执行 `collection add -> update -> embed -> status -> vec query -> get`，再验证 app 内 QmdProxy 和 Python 工具链；没有真实 bundle、签名 manifest 或 smoke asset 时不得用占位文件代替。

当前本地已通过 desktop 单元/契约测试、TypeScript 构建、Python 测试，以及使用真实 macOS 15+ arm64 standalone Python、候选锁定 wheelhouse、QMD/native addon、签名临时 manifest 和 embedding GGUF 的 packaged verifier；2026-09-07 clean-root metrics sidecar 记录的热查询 P95 约为 `27.9 ms`，冷启动约 `4.95 s`，verifier RSS 约 `240 MiB`。`desktop/build/runtime/wheelhouse` 已同步为 126 个 wheel（125 个基础包加应用 wheel），locked base closure 校验通过，但许可证报告仍阻塞于 `espeakng-loader 0.2.4` 的许可证和源码溯源确认。正式发布 HTTPS 资产地址、CI 密钥配置、应用签名/公证和许可证法律审查仍未就绪，因此不能把当前 staging 结果称为可发布安装包。

发布操作顺序、manifest 公钥轮换、许可证清单和 Apple 签名/公证要求见 [`docs/kb-runtime-release.md`](../docs/kb-runtime-release.md)。

## 自定义外观（Codex Pet 包）

兼容 Awesome Codex Pet 社区画廊的宠物包格式（`pet.json` + `spritesheet.webp`）：

- 扫描 `~/.codex/pets/`（Codex App 目录）与 `userData/skins/`（自己的导入目录）
- 默认帧规格 192×208、8 列 9 行（v1）；`pet.json` 可用 `frame` 字段覆盖
- 动画轨道对齐 Codex App（idle/running/waving/jumping/failed/waiting/review/working/attention），支持 `animations` 自定义
- 设置窗口「外观 → 悬浮球皮肤」选择，保存后自动重载生效
- `skin://` 协议安全地从磁盘读取贴图（路径限定在皮肤目录内）

相关模块：
- `src/main/skin-catalog.ts` —— 扫描 + 校验（WebP 尺寸/帧数上限/路径安全）
- `src/renderer/sprite-orb.ts` —— 动画模型（对齐 Codex App 无状态帧解析）
- `src/renderer/sprite-renderer.ts` —— canvas 帧渲染循环
