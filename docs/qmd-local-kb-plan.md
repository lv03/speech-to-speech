# 本地知识库检索（QMD）集成规划 v4

> 目标：把 [QMD (Query Markup Documents)](https://github.com/tobi/qmd) 作为"高质量本地检索"后端接入桌面语音助手，并**一并设计整体运行时获取策略**（Python 运行时 / Node+qmd / 模型下载 统一首次引导）。
> 状态：规划稿 v4（讨论修订：检索模型定为 Qwen3-Embedding-0.6B 经 `QMD_EMBED_MODEL` 接入；记忆层候选从 Hindsight 改为 **VoiceMem**（语音原生）；假设对话前端 = 本仓库桌面助手，待确认 P4）。事实核查日期：2026-08（QMD v2.8.3、Electron 43.4.0 / Node ≥ 22.12、npm 包 `@tobilu/qmd`、VoiceMem v0.0.2 / arXiv 2608.26005）。

---

## 1. 已拍板的边界（讨论结论，2026-08）

| # | 决策 | 影响 |
|---|---|---|
| D1 | 分发对象 = **普通用户** | qmd 必须随包分发，不能依赖用户装 Node/npm；需首次引导基建 |
| D2 | **整体运行时策略一并设计** | 新增统一 Runtime 获取层（Python + qmd + 模型），QMD 只是其中一个 runtime |
| D3 | 知识库功能**默认开启** | 但需"就绪分级 + 降级路径"避免默认开启=强制下载 2GB 模型/常驻内存（见 §3.3） |
| D4 | 语音侧工具 = **最小集** `search_knowledge` + `get_document` | schema 小、LLM 决策准 |
| D5 | **不内置项目 docs 集合** | 知识库仅由用户自选目录构成 |
| D6 | Electron 43 内嵌 Node ≥ 22.12 满足 QMD（Node ≥ 22） | `ELECTRON_RUN_AS_NODE=1` 直接跑 qmd，用户无需装 Node |
| D7 | **记忆层选型：VoiceMem 优先，弃 Hindsight**（见 §3.5） | Hindsight 是文本 agent 记忆服务（Hermes/Claude Code 向）；VoiceMem 是语音原生、流式在轮、可嵌本仓库语音循环 |
| D8 | **检索模型：QMD_EMBED_MODEL=Qwen3-Embedding-0.6B**（多语言/中文 GGUF，本地） | QMD 官方支持环境变量换 embedding 模型；切换后需 `qmd embed -f` 重嵌入；缓解 R1 中文风险 |
| D9 | 知识库内容载体 = **用户自己的 Obsidian vault**（`**/*.md`） | QMD collection 直接指向 vault 目录；LLM Wiki 插件属可选作者层，不参与检索链路 |

现状事实（决定 D2 的范围）：`desktop/README.md` 明示打包产物不含 Python 运行时，语音引擎依赖外置 `.venv` —— 连语音功能本身都还没有普通用户分发方案，QMD 是挂在同一个待建基建上的新组件。

---

## 2. QMD 是什么（事实核对结果）

| 项 | 结论 |
|---|---|
| 定位 | 端侧混合检索引擎：BM25(FTS5 `porter unicode61`) + 向量 + LLM 重排，专为 agentic/RAG 设计 |
| 安装 | npm `@tobilu/qmd` v2.8.3，bin=`qmd`，Node ≥ 22 |
| 推理 | node-llama-cpp 加载本地 GGUF，100% 本地无 API key |
| 模型 | 3 个本地 GGUF（~2GB，`~/.cache/qmd/models/`）：embedding（**可配**：`QMD_EMBED_MODEL`，中文默认换 **Qwen3-Embedding-0.6B**）、Qwen3-Reranker-0.6B（重排）、qmd-query-expansion-1.7B（查询扩展/lex/vec/hyde） |
| 索引 | 内容寻址 + SQLite FTS5 + sqlite-vec；配置 `~/.config/qmd/index.yml`、库 `~/.cache/qmd/index.sqlite` |
| 格式 | 默认 `**/*.md`，可配 `**/*.{md,txt}`；不含 PDF/Office |
| 延迟 | 冷 1–3s（模型加载）；热 200–500ms（结果有 SQLite 缓存）；官方建议 HTTP daemon 保活模型 |
| 接口 | CLI（`--json`：docid/score/file/title/context/snippet）；MCP：stdio / HTTP(`qmd mcp --http --port`，端点 `/mcp`) / daemon(`--daemon`) |

**关键风险 R1（中文质量，已有缓解路径 D8）**：QMD 默认 embedding 英文中心、FTS5 tokenizer（`porter unicode61`）无中文分词 ⇒ 中文 BM25 基本失效。缓解：换 Qwen3-Embedding-0.6B 多语言模型（重排本就是 Qwen3-reranker），语义检索走 vec/hyde，BM25 仍兑底英文术语/docid；Phase 0 实测默认 vs Qwen 的差距与 top_k 敏感性。

---

## 3. 运行时获取整体策略（本次设计核心，D2）

### 3.1 三个 Runtime 组件

| 组件 | 提供 | 现状 | 目标分发方式 |
|---|---|---|---|
| **python-rt** | 语音引擎（`cli local`）与 gateway 的 Python 解释器 + 依赖（torch/transformers/sherpa…） | 外置 `.venv`，仅开发者 | 首次引导下载独立 Python（分 OS 产物）→ `uv`/`pip` 装依赖到 `userData/runtime/python-venv` |
| **qmd-rt** | qmd + node-llama-cpp 原生二进制 | 无 | extraResources 随包分发（构建机 per-OS `npm ci`），`ELECTRON_RUN_AS_NODE=1` 启动 |
| **models** | 语音 STT/TTS 模型（已有机制）+ QMD 3 个 GGUF（新增 ~2GB） | 语音模型运行期自动拉取 | 统一下载器：镜像配置 + 断点续传 + 进度事件；GGUF 在首次 KB 检索前拉取 |

### 3.2 统一 Runtime Manager

新增 `desktop/src/main/runtime-manager.ts`（或 `runtimes/` 目录），对三个组件做**同一套状态机**，renderer 通过 IPC 订阅：

```
状态机: unknown → detecting → missing | ready
                     ↓ installing(下载中: bytes/total, 阶段) → ready | failed
  降级态: degraded（如 qmd-rt 就绪但 models 未下载 → KB 走 vec-only）
```

- `RuntimeProvider` 接口：`detect() / provision(onProgress) / health() / stop()`；三个实现 `PythonRuntime`、`QmdRuntime`、`ModelBundle`（内分 qmd-gguf / voice 模型条目）
- **共享下载器**：分片/断点续传、校验和、**镜像切换**（§3.4）、并发限速、取消；下载产物放 `userData/runtime/`（models 也可复用现有语音模型缓存目录，避免重复下载）
- **降级分级（D3 默认开的关键）**：
  - `unknown`：未探测 → 自动探测
  - qmd-rt 未就绪：KB 工具对 LLM 仍可见，但调用返回"知识库正在准备中"并触发后台 provision（不阻塞对话）
  - qmd-rt 就绪 + models 未就绪：中文场景 **BM25 腿基本无效（PoC 实证 0 命中）**，降级走 **vec-only（`qmd vsearch`，需 ~600MB embedding，不需 reranker/expansion）**；若连 embedding 也没有 → 返回"知识库未就绪"提示
  - 全部就绪：hybrid `qmd query`（PoC 实测 daemon 热查 **0.08–0.11s**，首查 0.92s；常驻 ~1GB，模型在子进程）

### 3.3 默认开启下的资源策略（D3）

默认开启 ≠ 启动即下载 2GB/常驻 ~1GB（PoC 实测热 daemon 实际常驻 ~1GB，模型在子进程）：
- 应用启动只做**探测**（qmd daemon 不常驻、模型不加载）
- 首次命中"知识库类问题"时懒触发：下载进度异步（orb 提示"正在准备知识库模型…"），下载完成后热启动 daemon；**期间及无模型时自动走 vec-only（`qmd vsearch`）**（中文下 BM25 不可用，PoC 实证）
- 设置页提供"启动时预热模型"开关（高级用户）
- daemon 仅在有 KB collection 时拉起；空闲可停

### 3.4 网络可达性与镜像（普通用户国内分发的硬门槛）

Phase 0 实测三处通道并固化配置（本机连 github.com 已实测不通）：
- npm registry → npmmirror 镜像（构建期/引导期均可）
- GitHub Releases（node-llama-cpp llama 二进制）→ 预下载/ghproxy 类加速/构建机代理后随包（**推荐：构建期解决，用户侧零下载**）
- HuggingFace（GGUF + 语音模型）→ `HF_ENDPOINT=https://hf-mirror.com` 等，下载器内置镜像列表 + 失败自动切换

### 3.5 记忆层选型：VoiceMem vs Hindsight（D7）

先澄清**三个不同平面**，避免混为一谈：

| 平面 | 解决什么 | 组件 |
|---|---|---|
| ① 对话短期上下文 | 当前这轮对话 | Realtime session（现成） |
| ② 用户长期记忆 | “我是谁 / 说过什么 / 偏好 / 情绪 / 关系”（跨会话懂你） | **VoiceMem**（语音原生） |
| ③ 文档知识检索 | Obsidian 等资料内容 | **QMD + Qwen3-Embedding** |

② 与 ③ 互不替代：VoiceMem 记的是**用户说过的事实**（如“我对坚果过敏”），不索引文档；QMD 检索的是**文档内容**，不理解用户人格。两者将来可打通（记忆节点引用 KB 文档），本期不做。

| | **VoiceMem**（推荐 ②） | Hindsight |
|---|---|---|
| 定位 | 实时语音智能体的记忆库（清华，arXiv 2608.26005） | 文本 agent 的持久记忆服务（Hermes/Claude Code 生态） |
| 输入 | 音频/转写（自带流式 ASR/VAD/声纹/情绪；本地 embedding multilingual-e5） | 对话文本 |
| 延迟 | 检索在语音轮次内流式预取（声称 ~134ms，~430 token/轮） | 文本向，调用在 agent 工具链中 |
| 形态 | Python **库**，`VoiceMem(reply=my_reply)` 保留自有回复模型，可嵌本仓库语音进程 | 独立**服务**（自带库/模型/MCP） |
| 中文 | FunASR zh 流式 + e5-small 多语言，中文社区活跃 | 文本向，需自配 LLM/embedding |
| 成熟度 | **v0.0.2（2026-08 发布，<1 月），~290 stars，API 可能变动** | v0.6+，有国内 Windows 部署指南，生态较成熟 |

**结论（D7）**：为“语音助手的长期记忆”选 **VoiceMem**：语音原生、检索在轮内、中文友好、Python 库形态可直接复用自家 STT 转写流、Apache-2.0。Hindsight 仅在将来面向文本 coding agent 记忆时再考虑。VoiceMem 属 **Phase 5 可选增强**（非 KB 问答必需件），benchmark 声称需 PoC 复验（R10）。

---

## 4. 目标架构（含运行时层）

```
┌─ Electron 桌面主进程 ───────────────────────────────────────────────┐
│ RuntimeManager (runtime-manager.ts)                                  │
│  ├─ PythonRuntime  ── 首次引导下载 Python + uv 装依赖 → venv          │
│  ├─ QmdRuntime     ── extraResources 内 qmd ─ ELECTRON_RUN_AS_NODE ─►│
│  │                     └ spawn qmd mcp --http --port 8321 (前台子进程) │
│  ├─ ModelBundle    ── GGUF/语音模型 下载(镜像/断点) → ~/.cache|userData│
│  └─ 状态机 → IPC → 设置页「运行时状态」+ 首次引导向导                     │
├─────────────────────────────────────────────────────────────────────┤
  python venv             qmd daemon http://127.0.0.1:8321/mcp
  ▲  spawn cli local      ▲                 ▲ (warm 200-500ms)
  │  语音引擎 ── Realtime 工具调用 ──► tools/qmd_knowledge.py (Python)
  │  tools: agent_gateway + qmd_knowledge(search/get)   └─ 最小 MCP-over-HTTP 客户端
  │  磁盘 KB 文件夹(用户自选 collection) ◄── qmd CLI 索引/更新/状态
  └─ gateway :3101 (coding agent) ── 可选：shell 直接 qmd query
```

---

## 5. 分阶段实施计划

### Phase 0 — 概念验证（0.5–1 天，先做，产出决策记录）

1. **网络矩阵**：npm registry / npmmirror、GitHub Releases 可达性、HuggingFace / hf-mirror —— 逐项记录可行通道（§3.4）
2. 安装 qmd（镜像方案下）→ `qmd collection add <真实中文语料目录>` → `qmd embed` 观察吞吐
3. **中文质量验证（R1）**：同一批中文问题对比 `qmd search`(BM25) / `vsearch` / `query`(hybrid) 的命中质量与延迟；验证 embeddinggemma 对中文语义召回
4. 延迟/内存：冷 vs 热（`qmd mcp --http` daemon）P50/P95 与常驻内存
5. **Electron-Node 冒烟**：`ELECTRON_RUN_AS_NODE=1 <Electron 可执行文件> <qmd bin> query …`，确认 N-API 绑定可跑
6. MCP HTTP 形态核对：SSE(legacy) vs streamable HTTP；Python 官包可连则用，否则记最小客户端要点
7. **Python 分发可行性抽查**：standalone Python（python.org / uv-managed）产物体积与 `uv pip install` 本仓库依赖链的可行性粗测
8. 定参数：默认模式、top_k、min-score、snippet 长度、daemon 端口（8321）

**出口**：中文 recall 可用 + 热查 < 1s + Electron-Node 跑通 + Python 分发路径可行 ⇒ Phase 1；否则按 R1 替代方案调整。

### Phase 1 — 运行时获取基建（最大块，约 2–3 天）

| 文件 | 内容 |
|---|---|
| `desktop/src/main/runtime-manager.ts`（新） | 状态机 + RuntimeProvider 接口 + 三个实现（§3.2）；下载器（镜像/断点/进度事件） |
| `desktop/src/main/qmd-runtime.ts`（新） | QmdRuntime：定位打包内 qmd（extraResources）→ 回退 PATH；`ELECTRON_RUN_AS_NODE` 探测；daemon 生命周期（随 KB 使用懒启动） |
| `desktop/src/main/python-runtime.ts`（新） | PythonRuntime：首次引导下载/定位 Python + 创建 venv + 安装 gateway/speech_to_speech 依赖（uv 优先）；**复用/收敛现有 `findPython()` 探测逻辑** |
| `desktop/package.json` + `electron-builder.yml` | 依赖 `@tobilu/qmd@2.8.3`；extraResources 打包 qmd node_modules；asarUnpack 原生绑定；产物按 OS 构建 |
| `desktop/src/renderer/` 首次引导向导 | 欢迎 → 运行时检查清单（Python/qmd/模型 三项打勾进度）→ 下载进度/镜像选择/重试 → 完成；`settings.html` 加「运行时状态」区（同状态机） |
| `desktop/src/preload/index.ts` | runtime 相关 IPC API（状态订阅/触发安装/取消） |

### Phase 2 — QMD 服务层 + 知识库设置（约 1–1.5 天）

| 文件 | 内容 |
|---|---|
| `desktop/src/main/qmd-service.ts`（新） | daemon 管理 + 索引代理：`qmd collection add/list/remove`、`update`、`embed`、`status --json`、`cleanup` |
| `desktop/src/main/settings.ts` | `DesktopSettings` 新增：`qmdPort`、`qmdSearchMode`(`hybrid|vec`)、`qmdWarmOnStart`、`kbCollections: string[]`；`enableQmd` **默认 true**（D3） |
| `desktop/src/main/index.ts` | 生命周期接入 RuntimeManager；EmbeddedVoice 启动 env：`QMD_URL`、`QMD_MODE`、`QMD_EMBED_MODEL=Qwen3-Embedding-0.6B`（D8，daemon 继承） |
| `settings.html/.ts`「知识库」区块 | collection 列表（文档数/更新/嵌入覆盖）、添加文件夹（目录选择）、移除、重新索引/嵌入、状态与降级提示（"语义检索模型未就绪，当前为关键词模式"） |
| 首启默认引导 | 无 collection 时提示"添加你的笔记/文档文件夹" |

### Phase 3 — Python 侧工具模块（约 1–1.5 天）

| 文件 | 内容 |
|---|---|
| `audio_client.py` + `cli.py` | `--tool-module` 支持多模块（`a,b`）：合并 TOOLS、聚合 dispatcher；单模块向后兼容；`CREATE_RESPONSE` 仅默认值（agent_gateway 每次调用的 `ToolResult(create_response=False)` 语义不受影响） |
| `src/speech_to_speech/tools/qmd_knowledge.py`（新） | 最小集：`search_knowledge(query, collection?, top_k=5)`、`get_document(docid_or_path, lines?)`；经最小 MCP-over-HTTP 客户端调 `QMD_URL`；按 `QMD_MODE` 走 query/search；超时保护；不可达/未就绪返回降级文案而非报错；中文紧凑响应（来源/得分/snippet 截断，token 预算 ≤1500，`ensure_ascii=False`） |
| 提示词 | `--instructions` 补充：何时用知识库工具、口语化、带来源、无命中明说 |
| `tests/` | mock transport 单测：命中/无命中/未就绪/超时/collection 过滤；多模块加载器单测 |
| `voice-process.ts` | 默认追加 `--tool-module agent_gateway,qmd_knowledge` |

### Phase 4 — 体验打磨 + 收尾（约 1–1.5 天）

- 语音 UX：工具调用期 orb 状态"检索知识库…"；回答带"根据《xxx》"；无命中话术
- 懒加载/预热衔接：首次 KB 问题触发的下载进度 → orb 提示 → 完成热切换（keyword→hybrid）
- 索引保鲜：可选目录 watcher（debounce → `qmd update`）+ UI"上次更新"时间
- coding agent 通路（可选）：gateway spawn 注入提示"可用 `qmd query` 查知识库"
- 模型/索引位置核对：`~/.config/qmd` 与 `~/.cache/qmd` 为全局路径，验证 XDG 环境变量可否随 app 隔离，避免污染用户既有 qmd 数据（若无则文档说明共享语义）
- 文档：startup-guide/使用说明（安装包分发场景的首次引导流程）

### Phase 5 — 进阶（暂不做，记录）

- **记忆层 VoiceMem（D7 路线）**：转录流 ingest（复用自家 STT 文本，避免重复部署 FunASR）、`recall_memory` 工具（左脑事实 + 右脑情绪/人格 Top-K 注入）、默认模型 env 纳入 ModelBundle、抽取 LLM 用 DeepSeek V4-Flash（快/便宜）或本地 Qwen；PoC 复验 134ms / 430 token / LoCoMo 91.2% 声称（R10）
- 自动 RAG 模式（每轮注入上下文 / "知识库模式"口令）
- PDF/Office 预转换流水线（pandoc/textutil → md 镜像目录）
- collection 分组路由（"公司文档 vs 个人笔记"）
- 文档类 embedding 备选（若 Qwen3-Embedding-0.6B 实测不达标，试 8B/Ollama 或其他多语言模型）

---

## 6. 变更清单（文件级）

```
desktop/
  package.json / electron-builder.yml      # + @tobilu/qmd、extraResources、asarUnpack
  src/main/runtime-manager.ts (新)          # 状态机 + 下载器 + RuntimeProvider
  src/main/qmd-runtime.ts / qmd-service.ts (新)
  src/main/python-runtime.ts (新)           # 收敛 findPython
  src/main/index.ts / settings.ts / voice-process.ts / preload/index.ts
  src/renderer/settings.html/.ts            # 首次引导向导 + 运行时状态 + 知识库区块
  tests/
src/speech_to_speech/
  api/openai_realtime/audio_client.py       # 多工具模块合并
  cli.py
  tools/qmd_knowledge.py (新)
tests/
docs/qmd-local-kb-plan.md                   # 本规划
```

## 7. 剩余待拍板

- **P1 Python 产物形态**（Phase 0 抽查后定）：随包携带 standalone Python（python.org 安装器产物 or `uv python install` 管理的独立构建）＋ uv 装依赖，还是仅随包 extraResources 放 uv + 首次引导在线装？体积 vs 首启下载时长的权衡
- **P2 语音模型是否本轮纳入统一下载器**：现语音引擎有自己拉取模型机制；本轮建议只统一机制+镜像配置（不重构拉取逻辑），GGUF 走新下载器 —— 是否接受
- **P3 镜像清单**：默认镜像顺序（官方 → hf-mirror / npmmirror）与是否允许用户自定义
- **P4（待确认）**：对话前端 = 本仓库 speech-to-speech 桌面助手（D 表以此为前提）；若实际是 Hermes/其他 harness，QMD 集成需另起炉灶
- **P5（待确认）**：VoiceMem 节奏：本轮路线图记录即可 / Phase 0 一并冒烟（pip install + 中文样本 ingest/search）/ 更优先

## 8. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | 中文质量不确定（英文 tokenizer + 默认英文中心 embedding） | **D8 已缓解**：`QMD_EMBED_MODEL=Qwen3-Embedding-0.6B`（重排本为 Qwen3）；Phase 0 实测默认 vs Qwen 差距；不达标试 8B/Ollama |
| R2 | 默认开启（D3）却要求下载 2GB/常驻内存 | §3.3 就绪分级：懒触发 + vec-only 降级（中文 BM25 不可用，PoC 实证）+ 预热开关；实际常驻 ~1GB |
| R3 | MCP HTTP 形态与 Python 客户端兼容 | 官包不可用则最小 SSE 客户端（协议面窄）；CLI 子进程兜底 |
| R4 | 工具调用增加 RTT 拖慢对话 | 最小工具集 + top_k 小 + min-score + QMD 自带 llm_cache |
| R5 | 索引不实时（需 `qmd update`） | watcher + debounce；UI 显式"上次更新" |
| R6 | 单 `--tool-module` 槽位 | Phase 3 合并加载（向后兼容） |
| R7 | 国内网络三处不通（npm/GitHub Releases/HF） | §3.4 矩阵实测 + 构建期解决二进制（用户零下载）+ 下载器镜像/断点/降级 |
| R8 | Python 运行时分发复杂度（D2 引入） | Phase 0 抽查产物与 uv 可行性；P1 决策后单列子任务；与 qmd 复用同一下载器/向导 |
| R9 | qmd 全局数据目录与用户既有安装冲突 | Phase 4 核对 XDG 隔离可行性；不行则文档明示共享语义 |
| R10 | **VoiceMem 成熟度**：v0.0.2（<1 月）、~290 stars、benchmark 为自研声称；自带 ASR/embedding 与自家 STT 重复 | 固定版本 + 进程内嵌（爆炸半径小）；复用自家转写文本 ingest；PoC 复验通过前不进产品主线 |

## 9. 参考

- QMD 文档：https://tobi-qmd-3.mintlify.app/ ｜ 仓库：https://github.com/tobi/qmd（npm `@tobilu/qmd`；embedding 可配：`QMD_EMBED_MODEL`，换模型后 `qmd embed -f`）
- Qwen3-Embedding：https://qwenlm.github.io/zh/blog/qwen3-embedding/（0.6B–8B 多语言表征）
- VoiceMem：https://github.com/xzf-thu/VoiceMem ｜ 技术报告：arXiv 2608.26005（v0.0.2，Apache-2.0）
- Hindsight：https://github.com/vectorize-io/hindsight（文本 agent 记忆服务，作为对照）
- 本仓库既有范式：`desktop/src/main/gateway-process.ts`（findPython/就绪轮询）、`src/speech_to_speech/tools/agent_gateway.py`（工具模块契约）
- 现状约束：`desktop/README.md`（打包产物不含 Python 运行时）
