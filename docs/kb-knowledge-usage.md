# 知识库（QMD）集成 · 操作手册

> 面向三种使用者：**最终用户**（桌面 UI）、**语音助手 LLM**（工具调用）、**开发者**（脚本/调试/运维）。
> 实现基线：`docs/kb-memory-integration-proposal.md`；代码：`desktop/src/main/*` + `src/speech_to_speech/tools/qmd_knowledge.py`。

---

## 0. 一句话模型

语音 LLM 通过两个工具（`search_knowledge` / `get_document`）提问 → Python 工具进程只认 **Electron 内 loopback 鉴权代理**（`QMD_PROXY_URL` + Bearer token）→ 代理背后是 **QmdService**（管理 collection、把内部 id 映射成短期 opaque `doc_*`）→ 真正检索由 **QMD 2.8.3 私有 daemon**（`ELECTRON_RUN_AS_NODE` 跑、MCP/SSE 协议）执行。**语音进程永远拿不到真实文件路径。**

---

## 1. 最终用户操作流（桌面设置页「知识库」tab）

状态机（设置页顶部显示）：`no_collection → needs_consent → installing/indexing → ready_vec`；失败/降级态有对应文案。

| 步骤 | 用户操作 | 背后发生了什么 |
|---|---|---|
| 1 | 打开设置 → **知识库** tab | 主进程 snapshot → UI 显示状态/模型/collection 列表（IPC `knowledge:snapshot`，事件 `knowledge:snapshot-changed` 实时刷新） |
| 2 | （首次）同意知识库使用 | RuntimeManager 显式 consent，随后才开始探测/下载 |
| 3 | **添加目录**（按钮）→ 选 Obsidian vault 文件夹 | IPC `knowledge:add-collection` → QmdService 校验目录（realpath/仅目录/NUL 防护）→ 建 QMD collection（内部名 `kb_col_<32hex>`，pattern `**/*.md`）→ 下载 embedding 模型（Qwen3-Embedding-0.6B，经 HF 镜像，进度条+取消+断点）→ 嵌入建向量索引 |
| 4 | 列表显示 collection：文档数/最后索引/状态；可**重新索引**（需确认）/**删除索引**（不动原文件）/**取消** | IPC `knowledge:reindex|delete-index|cancel`；索引指纹（manifest 驱动的 SHA-256）不一致会自动触发 pending→indexing |
| 5 | 可选：**检索模式**（默认"自动（v1 向量检索）"；"混合检索"置灰=未批准）、**启动后预热**开关（默认开，仅一次受控查询暖 daemon） | 切模式会让现有索引进入待重索引（不删文件） |
| 6 | 关闭设置，对语音助手说话提问 | 见 §2 |

约束：`addCollection` 走对话框选目录，collection 上限 32；displayName 有字符校验（禁 `/ \`、控制字符）。

## 2. 语音助手视角（LLM 工具契约）

`--tool-module agent_gateway,qmd_knowledge` 合并后共 5 个工具，其中知识库两个：

### search_knowledge
```jsonc
// LLM 调用
{"query": "我对什么食物过敏？", "collection_id": "col_<32hex>", "top_k": 5}   // collection_id 可省=全部
// 返回（Python 工具清洗后，中文 JSON，≤16KB）
{"status":"ok","results":[
  {"docid":"doc_3394…feb6","title":"饮食记录","source":"我的笔记/饮食记录.md",
   "score":0.81,"snippet":"1: @@ -1,3 @@ …\n2: 我是素食主义者，对坚果过敏…"}]}
```
- `query`：≤2000 字符，禁控制字符；`top_k` 1–8；请求 10s 超时
- `source` 是**清洗后的相对路径**（代理映射出的 vault 内相对路径+collection 名），不含盘符/`~`/绝对路径/反斜杠；snippet 里的绝对路径、`file://`、`~` 一律替换为 `[path omitted]`

### get_document（追问细节）
```jsonc
{"docid": "doc_<64hex>", "start_line": 1, "end_line": 20}   // ≤80 行；end_line 省略=从 start 起 80 行
// 返回整段 ≤16KB 内容，同样清洗
```
- `doc_*` 是 **QmdService 签发的短期句柄**（默认 TTL 30 分钟、上限 1024 个，先到先清），**过期/未签发 → 拒绝**，防止 LLM 拿着 id 无限期越权读文件

### 错误语义（LLM 应据此组织话术）
| 返回 | 含义 | 助手应说 |
|---|---|---|
| `proxy_unavailable` | 代理/daemon 不可达、超时、401 | “知识库暂时不可用/还在准备” |
| `knowledge_not_ready` / `indexing` | 索引未就绪（如模型下载中） | “知识库正在建索引，稍后再问” |
| `no_results` | 没查到 | 明说没找到，不要编造 |
| `invalid_request` / `document_not_allowed` | 参数非法/越权 | 换个问法 |

### LLM 行为引导（`--instructions` 语义）
- “涉及我的笔记/文档/项目资料” → 先 `search_knowledge`，命中后用片段回答并带来源（"根据《饮食记录》…"）
- 检索不到 → 直接说明，不臆造
- 需要原文细节再 `get_document`，不需要就别放大上下文

## 3. 一次 KB 问答的底层时序

```
用户说话 → STT → Realtime 会话（LLM 判定"知识类问题"）
  → 调 search_knowledge（同轮工具调用）
  → qmd_knowledge.execute_tool：校验参数 → httpx POST {proxy}/v1/search
       头: Authorization: Bearer <QMD_PROXY_TOKEN>（仅 127.0.0.1/::1 合法，10s 超时）
  → QmdProxy（随机端口，起于主进程）：验 token/body 上限(128KB)/query≤2000
  → QmdService.search：recordsFor（只查 enabled+indexState=ready 的 collection）
       → QmdMcpClient.query(query, kb_col_<hex>, top_k, mode)
  → QMD daemon：MCP tools/call query（vec-only: searches=[{type:'vec'}], rerank=false
       / hybrid: lex+vec + rerank=true，需 manifest 批准）
  → sqlite FTS/向量 → 结果
  → QmdService：safeFile（校验 qmd:// 主机名=内部名、realpath 必须在 collection root 内）
       → 签发 doc_ 句柄（映射 qmd docid，记 TTL）
  → QmdProxy → Python 工具二次清洗（source/title/snippet、[path omitted]、16KB 截断）
  → 工具结果回到 LLM → 组织口语化回答 → TTS
```
全程知识相关延迟目标：daemon 热查 80–110ms + 代理/映射 <5ms + LLM 决策 1 轮。

## 4. 开发者运维操作

### 常用 npm/脚本（desktop/ 下）
| 命令 | 作用 |
|---|---|
| `npm run dev` | 起 Electron（本机缺打包资源时走开发回退：`.venv` python） |
| `npm run prepare:qmd` | 从 node_modules 打包 qmd 私有运行时 → `build/qmd-resources`（128 包/171MB，darwin-arm64 原生预编译） |
| `npm run typecheck` / `npm test` | 类型 / vitest(137) + node(9) |
| `npm run verify:package` | packaged 验证门（需完整打包资源+签名，见 release 文档） |
| `node scripts/generate-license-report.mjs` / `validate-runtime-wheelhouse.mjs` | 许可证 / wheelhouse 校验 |

### 关键环境变量
| 变量 | 用途 |
|---|---|
| `QMD_PROXY_URL` / `QMD_PROXY_TOKEN` | 注入语音引擎子进程，指到主进程 loopback 代理（不可用时被删除） |
| `HF_ENDPOINT=https://hf-mirror.com` | 国内模型下载镜像（qmd 与打包工具通用） |
| `GATEWAY_PYTHON` / `QMD_SOURCE_NODE_MODULES` / `QMD_RESOURCES_DIR` | 开发定位（python/qmd 源与产物目录） |

### 想绕开 UI 直接摸 QMD（调试用，手动等价物）
```bash
QMD=desktop/build/qmd-resources/node_modules/@tobilu/qmd/bin/qmd
# 用 Electron 内置 node 跑（与应用同路径）
ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron "$QMD" \
  collection list / add <vault> --name kb_col_xxx --mask '**/*.md' / remove <name>
"$QMD" embed                     # 增量嵌入（换模型后 embed -f）
"$QMD" query "中文问题" --json -c kb_col_xxx -n 5   # 手动 hybrid 检索（含重排）
"$QMD" status                    # 索引健康/模型/待嵌入数
```
> 注意：应用内建索引名是 `kb_col_<32hex>`；全局索引库在 `~/.cache/qmd`，配置 `~/.config/qmd/index.yml`（**`models.embed` 已配 Qwen3-Embedding-0.6B**，models 段优先于 env）。生产路径不要手动改这里的 collection，走应用。

### 本机复现"去壳 E2E"
一条链：bundled daemon ↔ QmdMcpClient ↔ QmdService ↔ QmdProxy ↔ qmd_knowledge.py。做法（临时 vitest 或脚本）：起 daemon（`ELECTRON_RUN_AS_NODE` + `qmd mcp --http --port <p>`）→ 建 fixture collection 并 `embed` → 造一条 `indexState:ready` 的元数据 → `QmdService.search` → `QmdProxy.start()` 拿 url/token → 用 `.venv/bin/python` 调 `execute_tool('search_knowledge', …)`（**必须异步 spawn**，同步会阻塞事件循环自锁）。已在本机验证通过（健身问题→健身计划.md score 1.0）。

## 5. 速查边界（v1 现状）

| 项 | 现状 |
|---|---|
| 检索模式 | **hybrid 已批准**（manifest `approvedProfiles` 含 hybrid + reranker/generator 资产；`desktop/scripts/make-hybrid-manifest.mjs` 生成 `build/runtime-manifest.hybrid.json`，dev 默认自动加载）；设置页可选：自动（优先混合）/ 混合 / 向量；
| 文档格式 | `**/*.md`（含代码笔记的 AST 感知分块，语言: ts/tsx/js/py/go/rust） |
| 安全 | opaque id + TTL、路径穿越/符号链接越界/`\0`/绝对路径泄漏防护、16KB 响应截断、恶意 markdown 清洗、token 鉴权 loopback |
| 语音进程可读 | 仅清洗后相对来源 + 片段；**拿不到真实绝对路径**（产品取舍，追问"文件在哪"需另设计） |
| 模型 | Qwen3-Embedding-0.6B（嵌入）常驻 daemon；热查 ~80–110ms；整树内存 ~1GB |

## 6. 参考代码索引
- 工具/安全边界：`src/speech_to_speech/tools/qmd_knowledge.py`
- 多模块加载：`src/speech_to_speech/api/openai_realtime/audio_client.py`（`load_realtime_tool_modules`）+ `cli.py --tool-module a,b`
- 代理/服务/客户端：`desktop/src/main/qmd-proxy.ts`、`qmd-service.ts`、`qmd-mcp-client.ts`
- 运行时/索引/下载：`runtime-manager.ts`、`qmd-runtime.ts`、`qmd-indexer.ts`、`model-store.ts`、`python-runtime.ts`
- UI/IPC：`desktop/src/renderer/settings.html`（知识库 tab）、`src/main/index.ts`（`knowledge:*` handlers）、`src/preload/index.ts`
