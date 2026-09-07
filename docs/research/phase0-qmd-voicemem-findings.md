# Phase 0 概念验证记录：QMD + VoiceMem（2026-09-05）

> 对应 `docs/qmd-local-kb-plan.md` §5 Phase 0。环境：macOS 15.1 arm64，Node v22.19.0，QMD 2.8.3，VoiceMem 0.2.3（注意：**已从 README 展示的 0.0.x API 演进**）。

## 1. 网络矩阵（定稿）

| 目标 | 结果 | 结论 |
|---|---|---|
| registry.npmjs.org | 200 ✓ | npm 直连可用 |
| pypi.org | 200 ✓ | pip 直连可用 |
| **huggingface.co** | 000 ✗ | **必须 `HF_ENDPOINT=https://hf-mirror.com`** |
| github.com | 000 ✗ | 不通；node-llama-cpp 若需 GitHub Releases 二进制会失败（本次 npm 安装 38s 未触发，见 §2） |
| hf-mirror.com | 200 ✓ | GGUF/模型统一走此镜像 |
| modelscope.cn | 302 ✓ | 备选 |

**→ 落地**：RuntimeManager 下载器默认注入 `HF_ENDPOINT`；npm/pip 直连可用无需镜像；GitHub 系下载一律在构建机代理侧解决。

## 2. QMD 安装与运行

- `npm i @tobilu/qmd`（v2.8.3）38s/154 包成功，**未触发 GitHub 二进制下载** → 用户侧随包分发可行（Electron-Node 冒烟 PASS，见 §5）
- CLI 正常；`qmd status` 显示新能力：**AST Chunking（typescript/tsx/javascript/python/go/rust）**——代码文件也走 AST 感知分块
- 索引库全局：`~/.cache/qmd/index.sqlite` + `~/.config/qmd/index.yml`（与 v3 R9 预期一致）

## 3. 中文检索质量（R1 验证，语料=自建 10 篇中文笔记 kb-zh）

**Top-3 命中正确文件：**

| 模型 | vsearch 结果 |
|---|---|
| embeddinggemma-300M（默认） | **8/8**，7 条 Top-1，分数 0.3–0.69 |
| **Qwen3-Embedding-0.6B-Q8_0** | **8/8**，7 条 Top-1，分数 0.38–0.76（更高更分散）；"阿杰"条把正确文件排到第 2 |
| hybrid `qmd query`（Qwen embed + reranker + expansion） | 分数 0.75–1.0，分离度最好；"阿杰"条仍误排第 1 |

**BM25 中文对照：`qmd search "我对什么食物过敏"` → 0 结果**。FTS5 `porter unicode61` 对中文整句不可分词 ⇒ **关键词腿对中文基本死亡**（印证 R1）。

**结论**：
1. 小语料下默认 embedding 与 Qwen3-0.6B 都可用；Qwen 分差更明显。**维持 D8 选 Qwen3-Embedding-0.6B**，但"默认 vs Qwen"的差距需要**更大语料**才能定论（10 篇判别度过低）。
2. **修订降级路径**：BM25-only 降级对中文无效 ⇒ §3.2 降级应改为 **vec-only（vsearch）**（仍要 ~600MB embedding 模型，但不需要 reranker/expansion）。若连 embedding 都没有，中文检索无可用腿，降级为"知识库未就绪"提示而非降质量检索。
3. hybrid 的 reranker 纠偏有限（阿杰条依旧错），但对分差/阈值判定更有用。

## 4. 延迟与内存（语音场景关键数据）

**CLI 每次子进程调用（不可用于语音）：** vsearch ~1.5–3.3s/次，hybrid `query` ~2.7s/次（每次重载模型）。

**MCP HTTP daemon（`qmd mcp --http --port 8321`）热查询：**

| 测量 | 数值 |
|---|---|
| 首查（daemon 内模型加载） | 0.92s |
| 后续相同/不同问题 | **0.08–0.11s** |
| 常驻内存 | 树总 ~1.03GB（模型在**子进程** node，RSS ~990MB；主进程 39MB） |

**→ 落地**：语音场景必须走 daemon（0.1s 级，达标）；常驻 ~1GB（非 2GB），默认开启可接受但需懒启动策略（§3.3 不变）。

## 5. Electron-Node 冒烟（打包可行性）

`ELECTRON_RUN_AS_NODE=1 <desktop/node_modules/electron/dist/.../Electron(43.4.0)> <qmd bin> --version` → `qmd 2.8.3` **PASS**。Electron 内嵌 Node ≥22.12 满足 QMD。随包分发路径成立。

## 6. MCP HTTP 传输形态（R3 前置）

- 端点 `http://localhost:8321/mcp`，**只绑 ::1（IPv6 localhost）**；GET → 405；**POST + `Accept: application/json, text/event-stream`** → SSE `event: message` 响应（streamable-HTTP 风格，非 legacy /sse）
- 协议版本 2025-06-18；`initialize` 结果含 `Mcp-Session-Id` 头
- 工具：`query`（参数：query/searches/limit/minScore/candidateLimit/collections/intent/rerank）、`get`、`multi_get`、`status`
- ⚠️ **python 标准库 urllib POST 得到 502**，curl 正常（头/连接细节差异，待查）⇒ Phase 3 Python 客户端用 **httpx**（本项目已有依赖）并解析 SSE；会话头管理
- 响应用例（query 工具，服务端已排版好的文本，含 docid/分数/路径）

## 7. VoiceMem 冒烟（v0.2.3，2026-09-05 装机）

- `pip install voicemem` 成功，依赖很重：**torch 2.14 / funasr / modelscope / mem0ai 2.0.20 / qdrant-client / sentence-transformers / sherpa-onnx**（左脑基于 mem0 引擎，致谢同源）
- **API 已偏离 README**：`VoiceMem(api_key, mode='text_mode', base_url, openai_key, top_k, user_id...)`；`MODE_ALIASES`：normal→multi_modal、leftbrain_only→left_brain_single、text→text_mode；方法 ingest(text/audio)/search/warmup/reply_stream…
- **中文文本 ingest 阻塞点：抽取 LLM 强制要求 OpenAI 兼容 key**（`Missing credentials`），本地 embedding 仅用于检索腿。默认模型 gpt-4o-mini，可用 `OPENAI_MODEL` 覆盖、`base_url` 指向兼容端点（源码 `extract_facts_openai.py`）⇒ **接 DeepSeek 的配置 = `OPENAI_BASE_URL=https://api.deepseek.com` + `OPENAI_API_KEY` + `OPENAI_MODEL=deepseek-v4-flash`**
- 本地模型（e5 等）经 HF 下载 → 同样走 hf-mirror
- 纯本地（无 key）路径不存在（0.2.3 至少）；若要全离线需自托管 OpenAI 兼容端点或等其支持本地 SLM 抽取

**→ 待办**：用户提供 DeepSeek key 后用 `base_url` 配置补跑一次完整 ingest/search（中文本地 embedding + 云端抽取）。

## 8. 其他

- `uv` 已装（/opt/homebrew/bin/uv）→ P1（Python 分发）可行通道：uv 管理 standalone Python + `uv pip`，与方案一致
- 测试残留数据（PoC 用）：`~/.config/qmd/index.yml` 现含 kb-zh collection + `models.embed=Qwen3-Embedding-0.6B`（已改），`~/.cache/qmd/` 2.1GB 模型缓存；如需清掉：`qmd collection remove kb-zh` + 删除缓存目录

## 9. 对规划文档 v4 的修订点（待合入）

1. §3.2 降级分级：**BM25-only 降级对中文无效 → 改为 vec-only（vsearch）**；无 embedding 时直接"未就绪"提示
2. D8 实现注：**index.yml `models:` 段优先于 `QMD_EMBED_MODEL` 环境变量**（本次实证：env 被配置覆盖）→ RuntimeManager 应在首次 provision 时直接写 index.yml 的 models 段，而非依赖 env 透传
3. §2 模型行/资源策略：热 daemon 常驻 **~1GB**（子进程加载），非 2GB
4. Phase 3 客户端：httpx + SSE 解析 + `Mcp-Session-Id`；QMD_URL 需解析 localhost（::1）；MCP `query` 工具可直接传单条纯文本 `query`
5. VoiceMem：加入 R10 细节（API 演进快、依赖重、mem0 后端、需 key）；DeepSeek 配置三件套（OPENAI_BASE_URL/MODEL/API_KEY）
