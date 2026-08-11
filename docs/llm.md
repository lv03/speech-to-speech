# LLM 模块详解

> 对应源码：`src/speech_to_speech/LLM/`（language_model.py /
> base_openai_compatible_language_model.py / chat_completions_language_model.py /
> responses_api_language_model.py / chat.py / lm_output_processor.py / tool_call/ 等）。
> 配套概念：`pipeline/speculative_turns.py`（推测性回合）、`pipeline/cancel_scope.py`（取消作用域）、
> [STT 模块详解](stt.md)、[VAD 模块详解](vad.md)。

---

## 1. 模块组成

| 文件 | 行数 | 职责 |
|---|---|---|
| `language_model.py` | 1013 | **本地模型基类** `BaseLanguageModelHandler` + 文本/VLM 实现（transformers & mlx-lm） |
| `base_openai_compatible_language_model.py` | 830 | **API 基类** `BaseOpenAICompatibleHandler`（Responses & Chat Completions 共享编排） |
| `chat_completions_language_model.py` | 351 | Chat Completions 后端实现 |
| `responses_api_language_model.py` | 192 | Responses API 后端实现 |
| `chat.py` | 838 | **对话历史** `Chat` 类（有界缓存/压缩/回滚/工具配对） |
| `lm_output_processor.py` | 148 | 输出分流：有序事件（文本/工具）与 TTS 输入同队列保序输出（#453 重构） |
| `compaction_prompt.py` | 181 | 历史摘要压缩 prompt 构建 |
| `tool_call/` | 574 | 工具调用：代码块提取、函数签名、prompt 构建 |
| `voice_prompt.py` / `text_prompt.py` | 92 | 语音/文本两种 system prompt 模板 |
| `audio_input_notifier.py` | 63 | 音频输入通知 |
| `utils.py` | 100 | `remove_unspeechable`、`sent_tokenize`、`resolve_auto_language`、`response_wants_audio` |

**定位**：管线第三站。输入是 `GenerateResponseRequest`（携带 runtime_config + 会话 Chat），
输出流式 `LLMResponseChunk`（按句子分批）+ `TokenUsage` + `EndOfResponse`。

```
text_prompt_queue ──► LLM handler ──► lm_response_queue
                       │                ├─ LLMResponseChunk(句子块, 可带 tools)
                       │                ├─ TokenUsage(计费)
                       │                └─ EndOfResponse(回合终结哨兵)
                       └──► LMOutputProcessor ──► 有序事件 + TTS 输入（同一队列）
```

---

## 2. 双基类架构：本地模型 vs API 后端

```
                    BaseHandler[LLMIn, LLMOut]
                        │
        ┌───────────────┴────────────────┐
        ▼                                ▼
BaseLanguageModelHandler           BaseOpenAICompatibleHandler
(本地: transformers/mlx-lm)        (API: responses-api/chat-completions)
        │                                │
  ┌─────┴──────┐                   ┌─────┴──────┐
  ▼            ▼                   ▼            ▼
LanguageModel VisionLM          ResponsesApi  ChatCompletions
(文本)        (视觉)              ModelHandler  ApiModelHandler
```

| | 本地基类 | API 基类 |
|---|---|---|
| 生成方式 | token 迭代器（transformers streamer / MLX generator） | httpx 流式 ProviderEvent / 非流式响应 |
| 取消机制 | `_CancelCriteria`（StoppingCriteria）+ token 推进时检查 | 流迭代时检查（httpx 阻塞读无法中断，靠 `request_timeout_s` 兜底） |
| 工具提取 | 代码块正则 + `extract_function_calls_from_text` | 原生 ToolCall 事件 |
| 并发保护 | `_transformers_lock` / `MLXLockContext` | 无（无共享状态） |
| 抽象钩子 | `_load_model` / `_generate` | `_serialize` / `_request` / `_iter_events` / `_build_optional_kwargs` / `warmup` |

---

## 3. 核心处理流程（process，两个基类结构几乎一致）

```
1. 回合最新性检查: _turn_is_latest(turn_id, turn_revision)
   └─ 过期 → 直接 EndOfResponse, 不生成

2. 构建 active_chat:
   ├─ out-of-band 响应 (response.create 带自定义 input) → build_active_chat(临时对话)
   └─ 常规 → original_chat.copy() (不污染主历史, 提交时才写回)

3. 应用指令: _apply_instructions / _apply_config
   └─ voice 模式 → build_voice_system_prompt (带工具区/代码块规则)
   └─ text 模式 → build_text_system_prompt

4. 语言提示: resolve_auto_language + enable_lang_prompt 时插入
   "Please reply to my message in {lang}."

5. 生成: _generate
   └─ 流式消费 → 句子批处理 → yield LLMResponseChunk
   └─ 全过程中每步检查: cancel_scope 代数 / 回合是否仍最新

6. 提交历史 (can_commit 全通过时):
   ├─ out-of-band 不写回默认对话
   └─ 常规: assistant 消息 + 工具调用写入 original_chat
       → strip_images(已消费图片) → trim_if_needed(压缩/驱逐)

7. 收尾: TokenUsage (有 token 时) + EndOfResponse (永远产出, 失败也产出, error 字段标记)
   └─ 任何异常 → EndOfResponse(error=...) → LMOutputProcessor 发 ResponseFailedEvent
   └─ 防死锁关键: 没有 EndOfResponse 会导致 in_response 卡死
```

**事务语义**：`_generate` 里 `rollback_transaction`——如果历史提交失败或回合过期，
回滚整个回合的写入。

> ⚠️ #453 重构后：LLM 输出不再是"文本块 + 可选工具"，而是**有序 parts 列表**
> （`AssistantTextPart`/`AssistantToolCallPart` 交错）。历史写入变为**事务性**：
> Chat 用 `add_provisional_generation_items` 原子写入并按 `response_key` 跟踪，
> `finalize_provisional_generation` 提交 / `rollback_provisional_generation` 回滚。

---

## 4. 流式与句子批处理（语音 vs 文本两条路径）

### 4.1 语音模式（wants_audio=True）

```
token/TextDelta → remove_unspeechable(去 TTS 不友好符号)
  → sent_tokenize 切句 → 攒满 stream_batch_sentences(默认3) 才 yield 一个 chunk
  → 下游 TTS 拿到完整句子, 合成更自然
  → 流式返回: 用户说话可打断 (interruptible)
```

### 4.2 文本模式（wants_audio=False）

```
token/TextDelta → 原样透传 (不过滤符号、不切句 —— sent_tokenize 会压坏 markdown/换行)
  → 每个 delta 立即 yield (保持可打断性)
```

### 4.3 本地模型代码块处理（`_process_printable_text`）

针对语音转写场景的**工具调用隐式协议**：模型用**代码块**表达工具调用
（`<enter_code>` 标记后跟 JSON），而不是原生 tool call。处理流程：

```
检测到 enter_code 标记:
  ├─ 标记前的完整句子先 flush 成 chunk
  └─ 代码块内提取函数调用 (build_block_regex 匹配)
      └─ 每响应最多 1 个工具调用 (超过告警跳过)
      └─ 转换失败/非法调用 → 告警跳过
```

---

## 5. 工具调用闭环（两种基类对比）

**本地基类**：

```
LLM 输出代码块 → extract_function_calls_from_text → to_realtime_function_tool_call
  → 校验签名 (signature_from_schema) → tools 列表 → 随 chunk 下发
  → 提交时写 RealtimeConversationItemFunctionCall 入历史
```

**API 基类**（原生支持，有序）：

```
ToolCall 事件 → _record_tool_call:
  1. 先 flush 已累积的 assistant 文本入历史 (保证顺序 = 客户端看到的顺序)
  2. 立即把 function_call 写入 Chat ← 关键!
     └─ #453 后: chat.add_ordered_function_call (有序写入, 带 response_key 跟踪)
  3. 再 yield chunk 给客户端 (parts 列表保序)
  原因: 客户端可能极快返回 function_call_output, 若 call 还没入库会被拒
       ("No function_call with call_id ... found"), 模型会重复发起同一调用
```

**Chat 的工具配对**（`chat.py`，#453 事务化）：

- `append_tool_output(call_id, output)`：找到配对的 function_call → 标记 completed → 追加 output。
- **被驱逐的 call 兜底**：`_pending_tool_calls` 保留已因历史裁剪被驱逐的 function_call，
  输出回来时**重新注入**再配对——防"调用被裁了但客户端还了结果"。
- **事务化**：`add_ordered_function_call` / `add_provisional_generation_items`（原子写入 +
  按 `response_key` 跟踪 item_ids/call_ids）；`finalize_provisional_generation` 正常提交，
  `rollback_provisional_generation` 打断/失败时按 key 回滚。

---

## 6. 对话历史 Chat 类（`chat.py`，838 行）

**有界历史管理**，所有操作过 `_lock`：

| 机制 | 行为 |
|---|---|
| 软上限 `size` | 用户回合数超限 → `trim_if_needed` 驱逐最老完整回合 |
| 硬上限 `2*size` | 客户端失控兜底：内联驱逐（有损） |
| 压缩（compactor） | `size` 超限时后台线程调用 LLM 摘要旧回合为 user/assistant 对；单飞（进行中不再触发） |
| 回滚 `rollback_provisional_generation` | 打断/失败时按 `response_key` 撤销未完成回合的写入（#453 事务化） |
| 系统消息 | 独立存 `init_chat_message`，不进 buffer |
| 导出 | `to_responses_api_chat` / `to_transformers_chat` 两种格式 |
| 音频历史 | `compact_audio_history(max_audio_turns)` 压缩音频条目（API 语音输入用） |
| 图片 | `strip_images(consumed_ids)` 只剥离模型实际消费的图片 |

---

## 7. 取消与打断（三个闸门）

```
1. cancel_scope.generation 代数:
   └─ 每次 response.create 递增; 旧代数输出全部作废
   └─ 流式场景在 token 推进时检查 (无法中断 httpx 阻塞读, 靠 timeout)

2. speculative turns:
   └─ _turn_output_allowed = is_latest_after_reopen_grace
   └─ 回合被重开(revision+1)后, 旧 revision 的生成立即停

3. stop_event (shutdown):
   └─ 本地基类 _check_stop 三合一检查
```

本地基类还有 `_CancelCriteria`（transformers StoppingCriteria 注入 generate 循环），
打断时 `cancel()` 让 generate 提前退出；MLX 侧直接 close generator。

---

## 8. 语音输入支持（`stt=none`，音频直进 LLM）

`BaseOpenAICompatibleHandler._process_audio`（`supports_audio_input` 能力标记后端）：

```
request.audio (np.ndarray) → _audio_to_wav_base64 (内存 WAV 编码, 不落盘)
  → make_user_audio_message → 按后端协议序列化:
     ├─ Responses API: input_audio (原生)
     └─ Chat Completions: audio_url (data URI) 或 input_audio
  → 事务式提交: 先加 provisional 用户消息, 完成后 compact_audio_history(audio_history_turns)
  → 失败自动回滚
```

---

## 9. LMOutputProcessor — 有序输出分流器（#453 重构）

> ⚠️ **重要**：重构后不再使用 `text_output_queue`。所有输出（事件 + TTS 输入）
> 走**同一个队列**（`lm_processed_queue` → TTS handler 透传 → `send_audio_chunks_queue`），
> 文本/工具/音频在模型输出顺序上严格一致。`setup` 不再接收 `text_output_queue`。

内部维护 `_response_key`（uuid），同一响应的所有输出打同一 key：

| 输入 | 输出（同一队列，保序） |
|---|---|
| `LLMResponseChunk`（`parts` 有序列表） | 每个 part 一个 `AssistantOutputEvent`（`response_key`）；文本 part 且 `wants_audio` → 紧跟 `TTSInput`（同 key） |
| `TokenUsage` | `TokenUsageEvent`（不再走侧信道，与音频同队列；带 `cancel_generation`/`response_key`） |
| `EndOfResponse`（正常） | `AssistantResponseDoneEvent`（有序输出结束标记）+ 透传 `EndOfResponse` |
| `EndOfResponse`（error） | `ResponseFailedEvent` + 透传 `EndOfResponse` |
| `EndOfResponse`（stale 回合） | 只发 `cleanup_only` 的 `EndOfResponse`（生命周期收尾，绕过下游 speculative 门控） |

所有文本输出先过 `_turn_output_allowed`（speculative grace 过滤）。

send loop 侧：`response_key` 用于丢弃已关闭响应的迟到输出
（`_response_key_is_obsolete` / `close_response_key`，见 [realtime-api.md](realtime-api.md) §5.2）。

---

## 10. Prompt 体系

```
voice_prompt.py:   build_voice_system_prompt(instructions, tool_section?)
                   └─ 语音助手人设: 简洁口语化、不输出 markdown、工具用代码块表达
text_prompt.py:    build_text_system_prompt(instructions)
compaction_prompt.py: 摘要压缩 prompt (system+user → 精简摘要)
tool_prompt.py:    build_tool_system_prompt(functions, text_only) + build_block_regex
```

---

## 11. 后端配置速查

| 后端 | 默认模型 | 关键参数 |
|---|---|---|
| `transformers` | Qwen/Qwen3-4B-Instruct-2507 | device/torch_dtype/compile_mode/enable_thinking |
| `mlx-lm` | mlx-community/Qwen3-4B-Instruct-2507-bf16 | Apple Silicon 默认 |
| `responses-api` | gpt-5.4-mini | base_url/api_key/stream/stream_batch_sentences |
| `chat-completions` | 同上 | 同上 |

API 后端特殊处理：`_build_extra_body` 按提供商禁用推理（vLLM/Qwen 走
`chat_template_kwargs.enable_thinking=false`，GLM 走 `reasoning_effort='none'`；
官方 OpenAI 服务器拒绝未知 extra_body 键所以跳过）；本地 base_url（localhost/loopback）
自动用 `api_key="none"`。

---

## 12. 设计要点总结

1. **双基类抽象**：本地（token 迭代 + 代码块工具协议）与 API（ProviderEvent + 原生工具）
   完全不同的生成模型，共享同一套编排骨架（speculative gating / 取消 / 句子批 / 历史事务提交）。
2. **EndOfResponse 永不缺席**：任何异常路径都必须产出（带 error），否则 `in_response`
   状态卡死后续所有响应。
3. **语音/文本双路径**：语音要切句+净化（TTS 友好），文本要原样流式（保 markdown）——
   一个 `wants_audio` 分支贯穿所有消费逻辑。
4. **工具调用提前入史**：防客户端竞态；被驱逐的 call 有重新注入兜底。
5. **历史事务化**：copy-then-commit + 按 `response_key` 的 provisional 跟踪/回滚，打断/失败不污染主对话（#453 增强）。
6. **有序输出**：文本与工具调用以 `parts` 列表保序贯穿 LLM → 事件 → 音频链路，消除文本/工具乱序（#453 核心目标，对应 #309）。

---

*本文档随代码演进维护；如与源码行为不一致，以 `src/speech_to_speech/LLM/` 为准。*
