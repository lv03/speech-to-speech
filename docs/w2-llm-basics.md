# W2 学习讲义 —— 大模型推理基础

> 配套：[面试准备清单](interview-prep.md) B1-B6 · 目标：能对比四大 LLM 后端、能画工具调用时序
> 周验收：脱稿讲"流式 + 工具调用闭环 + 多后端差异"3 分钟

---

## B1 LLM 流式生成

### 概念（背熟）

| 术语 | 含义 |
|---|---|
| **自回归生成** | 模型逐个 token 生成，前一个 token 拼进输入再生成下一个 |
| **KV Cache** | 缓存已生成 token 的注意力键值对，避免每步重算历史（提速关键） |
| **流式输出** | 生成一个 token 就发送一个（SSE/增量事件），不等全部生成完 |

### 项目里的实际

**为什么按句子分批（核心）**：

```
LLM 流式 token ──► 攒句子 ──► 满 3 句才下发 TTS
  · sent_tokenize 切句（NLTK）
  · stream_batch_sentences = 3（可配）
  · 为什么：不等整段响应（低延迟） + TTS 拿到完整句子（合成更连贯）
```

**语音 vs 文本两条路径**（wants_audio 分支）：

| | 语音模式 | 文本模式 |
|---|---|---|
| 文本处理 | `remove_unspeechable` 去 TTS 不友好符号 + 切句 | **原样透传**（不过滤，保 markdown/换行） |
| 流式粒度 | 满 3 句一批 | 每个 delta 立即发 |
| 原因 | TTS 要干净句子 | 文本要可打断 + 不损坏格式 |

---

## B2 工具调用闭环（function calling）

### 闭环时序（要能画）

```
LLM 流式产出工具调用
  → 客户端收到 response.function_call.arguments.done (call_id)
  → 客户端执行工具（调 API/查库）
  → 客户端发 conversation.item.create(function_call_output) 回注
  → 服务端写入 Chat
  → 客户端 response.create → 新一轮生成（LLM 携带工具结果继续）
```

### 竞态防护（面试加分，三层）

1. **提前入史**：工具调用在暴露给客户端**之前**先写入 Chat——否则客户端极快返回结果时，服务端找不到配对的 function_call 会拒（"No function_call with call_id ... found"），模型被迫重复调用
2. **被驱逐调用重注入**：长对话里历史被裁剪，function_call 被丢——结果回注时从 `_pending_tool_calls` 找到并**重新注入**再配对
3. **事务化回滚**：历史写入按 `response_key` 跟踪（provisional generations），打断/失败时按 key 整体回滚——不污染对话状态

### 本地模型的特殊实现（加分）

本地 transformers/mlx 模型用**代码块协议**（不是原生 tool call）：

```
模型输出：<enter_code> 标记 + 代码块内 JSON 函数调用
项目用正则提取 → 校验签名 → 转成标准 function_call 下发
每响应最多 1 个工具调用（多则告警跳过）
```

---

## B3 多后端差异（必背对比表）

| | transformers | llama.cpp | vLLM | MLX |
|---|---|---|---|---|
| 权重格式 | HF safetensors | **GGUF**（量化） | HF safetensors | MLX 转换权重 |
| 实现 | Python 库 | C++ | 服务化引擎 | Apple Silicon 专用 |
| 部署 | 进程内 | llama-server（OpenAI 兼容） | 高并发服务 | 进程内（mps） |
| 特点 | 灵活但慢 | CPU/GPU 高效、量化好 | **PagedAttention 批处理**、生产级 | Metal 加速 |
| 本项目角色 | 本地后端之一 | 本地低资源部署 | 远程高并发 | mac 默认路径 |

**一句话**：同一模型四种格式（safetensors/GGUF/MLX），同一个 OpenAI 兼容接口（llama-server/vLLM），差异在格式转换与部署形态。

---

## B4 reasoning 机制（思考开关）

### 概念

Qwen3 等思考模型：正式回答前先输出一段**内部思考**（reasoning），再给最终答案。思考会：增加首字延迟 + 消耗 token。

### 关闭的三种层级（要能讲）

| 层级 | 方式 | 作用 |
|---|---|---|
| 请求层 | `chat_template_kwargs.enable_thinking=false` | 单请求关闭 |
| 服务器层 | llama.cpp `--reasoning off` | 服务器级兜底 |
| API 参数 | `reasoning_effort=none` | 部分供应商支持 |

### 项目实现（结合代码讲）

```
_build_extra_body(base_url, disable_thinking, reasoning_effort):
  · 官方 OpenAI 服务器 → 不发（官方拒绝未知 extra_body 键）
  · 非官方（llama.cpp/vLLM）→ 发 chat_template_kwargs.enable_thinking=false
  · 若配了 reasoning_effort → 优先用它（部分供应商只认这个）
```

**实测验证**（你做过，能讲）：
- 带 `enable_thinking=false` → `reasoning_tokens=0`，直接出答案
- 不带 → 先出一长串 reasoning 再回答
- llama.cpp 还需要 `--reasoning off` 兜底（请求参数未必覆盖所有路径）

**项目为何忽略思考**：`_iter_stream_events` 只处理 `output_text.delta`，`reasoning_text.delta` 被忽略——思考内容不会进 TTS，用户听不到，但会占延迟和 token，所以语音场景要关。

---

## B5 量化格式（选读，加分）

| 格式 | 位宽 | 1B 参数体积 | 精度 | 用途 |
|---|---|---|---|---|
| BF16 | 16bit | ~2GB | 高 | 训练/精度优先 |
| GGUF Q8_0 | 8bit | ~1GB | 接近原版 | llama.cpp 高质量部署 |
| GGUF Q4_K_M | 4bit | ~0.5GB | 可接受 | 低资源部署（主流） |
| MLX 6bit | 6bit | ~0.75GB | 好 | Apple Silicon |

**项目实测**：Qwen3-0.6B 的 Q8_0 GGUF = 639MB（ModelScope 下载），对应上表 8bit 估算吻合。

**取舍逻辑**：体积 ↔ 精度 ↔ 目标硬件（内存/显存）；对话场景 Q4_K_M 是甜点位。

---

## B6 上下文管理（对话历史）

### 项目实现（Chat 类）

```
有界 buffer：size = 保留的用户回合数（可配，默认 10）
  ├─ 软上限：超限 → trim_if_needed 驱逐最老【完整回合】（到下一个 user 消息边界）
  ├─ 硬上限 2×size：客户端失控兜底（内联驱逐）
  └─ 压缩（可选）：后台线程用 LLM 把旧回合摘要成精简 user/assistant 对（单飞不重入）
```

### 事务化（结合 B2）

```
生成开始 → active_chat = original_chat.copy()（副本操作，不污染主历史）
生成中工具调用 → 提前写入主历史但按 response_key 跟踪（provisional）
生成结束 → finalize 提交 / 打断或失败 → rollback_provisional_generation 回滚
```

### 多格式导出（面试可提）

同一份历史导出两种格式喂给不同后端：`to_responses_api_chat`（Responses API）/ `to_transformers_chat`（本地 transformers 模板）。

---

## 周验收自测

1. **默画工具调用闭环时序图**（LLM → 客户端 → 回注 → 下一轮）
2. **报出**：句子分批 = 3 句 / stream_batch_sentences；为什么不等全文
3. **对比**：四大 LLM 后端的格式与部署形态（一张表）
4. **讲清**：思考开关的三层关闭方式 + 项目 _build_extra_body 的分支逻辑
5. **报数字**：BF16 2GB/B / Q8 1GB/B / Q4 0.5GB/B（1B 参数模型）
6. **讲清**：历史为什么 copy-then-commit + 按 response_key 回滚

---

*W2 讲义完 · 下一篇：W3 系统架构与并发*
