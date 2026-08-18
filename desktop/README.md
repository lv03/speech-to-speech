# speech-to-speech Desktop

桌面悬浮球（Electron + TypeScript），内嵌启动 Agent Gateway，可给 coding agent
派任务，后续接入语音对话与唤醒词。

## 技术栈

- Electron 43 + TypeScript
- electron-vite 构建（main / preload / renderer 三端 TS）
- 主进程内嵌启动 Python Gateway（`python -m gateway`）

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
│   │   └── gateway-process.ts # 内嵌 Gateway 子进程管理（Python 探测 + 就绪轮询）
│   ├── preload/
│   │   └── index.ts           # contextBridge 暴露 desktop API
│   └── renderer/
│       ├── index.html         # 悬浮球 + 任务面板
│       ├── orb.ts             # 前端逻辑（WS 事件 + 任务列表 + 派任务）
│       └── style.css
└── electron.vite.config.ts
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `GATEWAY_ROOT` | 自动推断（仓库根） | 含 `gateway/` Python 包的目录 |
| `GATEWAY_PYTHON` | 自动探测 | Python 解释器（优先 `.venv/bin/python`） |
| `GATEWAY_PORT` | `3101` | Gateway 端口 |
| `VOICE_PORT` | `8765` | 语音引擎 Realtime 端口 |
| `GATEWAY_URL` | `http://127.0.0.1:3101` | 语音引擎工具模块访问的 Gateway 地址 |

## 当前状态（Phase 3 进行中）

- [x] 浮动 orb 窗口（透明无边框置顶，可拖动）
- [x] 托盘图标 + 菜单（显示悬浮球 / 设置… / 退出）
- [x] 内嵌启动 Gateway + 就绪探测
- [x] orb 前端：Gateway 状态 + 任务列表 + 派任务（WS /events 实时刷新）
- [x] 设置窗口：后端 Agent 类型、Gateway 端口、语音引擎开关、唤醒词开关/文本、悬浮球皮肤
- [x] **自定义外观**：兼容 Awesome Codex Pet 宠物包（pet.json + spritesheet.webp），扫描 `~/.codex/pets/` + 自己的 skins 目录，sprite 帧动画渲染，状态映射动画轨道（idle/working/attention…）
- [x] **内嵌启动 speech-to-speech 语音引擎**：spawn `speech-to-speech local`，挂工具模块（agent_gateway）+ 唤醒词，就绪探测（stdout 启动完成消息）
- [x] **状态动画接通**：Gateway 任务状态 → working/idle；语音状态 → listening/thinking/speaking/idle（通过 local 模式 `--local_audio_print_json` 的 EVENT 事件解析）
- [x] **全局快捷键 + 自动休眠**：可配置唤醒快捷键（切换悬浮球显示/隐藏），空闲自动隐藏
- [x] **Electron 打包**：electron-builder（macOS zip/dmg，未签名）
- [x] **声纹注册 UI 入口**：设置窗口可查声纹状态、注册（录 3 遍唤醒词，进度实时显示）、验证；启用后语音引擎加 `--enable_voiceprint`

## 打包

```bash
cd desktop
npm run dist:mac    # 生成 dist/speech-to-speech-*.zip 与 .app（未签名）
```

> 打包产物不含 Python 运行时：内嵌 Gateway / 语音引擎依赖 `GATEWAY_ROOT`（项目根目录）与
> `GATEWAY_PYTHON`（.venv Python）环境变量。分发到其它机器需先具备这些运行时。

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
