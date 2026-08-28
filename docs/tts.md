# TTS 模块详解

> 对应源码：`src/speech_to_speech/TTS/`（qwen3_tts_handler.py / kokoro_handler.py /
> pocket_tts_handler.py / facebookmms_handler.py / chatTTS_handler.py）。
> 配套概念：`pipeline/speculative_turns.py`（推测性回合，TTS 是回合提交点）、
> `pipeline/cancel_scope.py`（取消作用域）、[LLM 模块详解](llm.md)、[STT 模块详解](stt.md)。

---

## 1. 模块组成

| 文件 | 行数 | 职责 |
|---|---|---|
| `qwen3_tts_handler.py` | 1061 | **默认后端**：Qwen3-TTS（三模式：声音克隆/预设音色/音色设计） |
| `openai_compatible_handler.py` | 744 | OpenAI 兼容端点（`--tts openai`，远程合成） |
| `kokoro_handler.py` | 420 | Kokoro-82M（8 语言，自动语言切换） |
| `pocket_tts_handler.py` | 233 | Kyutai Pocket TTS（轻量、CPU 优先） |
| `facebookmms_handler.py` | 224 | Facebook MMS VITS（多语言，语言切换重载模型） |
| `supertonic_tts_handler.py` | 212 | Supertonic ONNX（10 个内置音色） |
| `omnivoice_handler.py` | 178 | OmniVoice（声音克隆，k2-fsa） |
| `chatTTS_handler.py` | 117 | ChatTTS |
| `README.md` | — | 各后端用法与语言映射 |

**定位**：管线第四站（最后一站）。输入是 `TTSInput`（LLM 句子块）与 `AssistantOutputEvent`
（#453 后事件与音频同队列，TTS **透传**事件到 output_queue）、`EndOfResponse`（哨兵），
输出是 **512 样本一块的 int16 PCM16 音频块**（16kHz）+ 透传的响应事件，直接进
`output_queue` → send loop → 客户端。

```
lm_processed_queue ──► TTS handler ──► output_queue (AudioOutItem)
                        ├─ bytes/int16 chunks (每块 512 样本, 32ms)
                        └─ AUDIO_RESPONSE_DONE 哨兵 (EndOfResponse 触发)
```

---

## 2. Qwen3-TTS（默认后端，1005 行）

### 2.1 双引擎

| 平台 | 引擎 | 说明 |
|---|---|---|
| Apple Silicon | mlx-audio（`mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice`） | 忽略 non_streaming_mode；`streaming_interval = chunk_size / 12`（12Hz codec 帧率） |
| 其他 | faster-qwen3-tts（`Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`） | `backend="ggml"`（默认，GGUF 量化）或 nanotron；支持 parity_mode |

### 2.2 三种生成模式（按模型类型自动分派）

```
_warmup_process / process:
  ├─ 有声音克隆参考 (ref_audio / ref_spk) → _process_voice_clone
  ├─ 模型类型 custom_voice → _process_custom_voice (预设 speaker)
  ├─ 模型类型 voice_design → _process_voice_design (instruct prompt)
  └─ base 模型但无参考 → ValueError (必须给 ref_audio)
```

**声音克隆**：`ref_audio`（原始音频）或缓存引用 `ref_spk` + `ref_rvq`（GGML 缓存向量）。
参数互斥校验严格（`_validate_ggml_options`）：talker/codec GGUF 路径必须成对、
ref_audio 与缓存引用互斥、ref_rvq 必须配 ref_spk + ref_text 等。

### 2.3 流式公共循环（`_stream`）

所有模式共享，关键点：

```
1. 每个 item 检查 cancel_scope 代数 → 打断即停
2. 模型输出(可能 24kHz) → _resample_to_pipeline_sr 重采样到 16kHz → int16
3. 首块静音修剪: 掐掉起始静音 ramp, 但保留 40ms preroll 防切掉软辅音
4. 按 blocksize(512) 切块 + leftover 拼接处理
5. 日志: TTFA(首音频延迟) + RTF(实时率) 每回合
6. 整个生成包在 MLXLockContext(10s 超时) 里 (Apple Silicon)
```

### 2.4 max_new_tokens 智能估算（`_estimate_max_new_tokens`）

按文本内容估计 codec token 数，避免截断也避免浪费：

```
词数/秒 + 字符数/秒 + CJK 字符数/秒(取最大) + 标点停顿(每个0.4s) + 基础 prompt 时长
→ × 12Hz × 安全系数 1.35 → 对齐到 chunk_size 整数倍 → 封顶到 max_new_tokens
```

### 2.5 文本合并优化（`_coalesce_pending_tts_input`，#453 按 response_key）

LLM 是 3 句一批产出 chunk 的，TTS 合成前**把输入队列里同 `response_key` 的后续 TTSInput
一并取出合并**成一段文本一次合成——减少合成次数、提升连贯性。

#453 重构后队列混合 `AssistantOutputEvent` 与 `TTSInput`（同 key 保序）：

- `same_response(item)` 按 `response_key` 判定是否合并（替代旧版按 turn_id/revision）。
- 合并过程中收集同 key 的 `AssistantOutputEvent`，**透传**到 `queue_out`
  （`self.queue_out.put(cast(TTSOut, event))`），保证文本事件先于对应音频到达 send loop。
- 语言变化、哨兵（SESSION_END/PIPELINE_END/EndOfResponse）或 key 不匹配时停止合并。

### 2.6 会话 voice 动态切换（`_apply_session_voice_override`）

客户端 `session.update` / `response.create` 里带 `voice` 时动态切换：

- custom_voice 模型：voice 必须是支持的 speaker 名（大小写不敏感匹配）
- 声音克隆模型：voice 是音频文件路径 → 换 ref_audio

`on_session_end()` 恢复初始 voice/ref。

---

## 3. Kokoro-82M（418 行）

### 3.1 双引擎 + 预加载

| 平台 | 引擎 |
|---|---|
| MPS | mlx-audio（`mlx-community/Kokoro-82M-bf16`） |
| CUDA/CPU | 原生 kokoro `KPipeline`（`hexgrad/Kokoro-82M`） |

MLX 后端**预加载 pipeline 和 voice tensor**（避免每次 generate 都重载），
并预取 3 种常用语言声音（a/e/f）。

### 3.2 自动语言切换

STT 语言码 → Kokoro 语言/声音映射（`WHISPER_LANGUAGE_TO_KOKORO_LANG`）：

```
检测到新语言 → 查 KOKORO_LANG_DEFAULT_VOICES 默认声音
  → 加载新 pipeline + voice → 切换
  → 失败则保持当前语言 (告警)
```

Kokoro 声音命名规则：**首字母=语言**（a=美式/b=英式/e=西语/f=法语/h=印地语/i=意语/j=日语/p=葡语/z=中文），
**次字母=性别**（f=女/m=男）。

### 3.3 音频处理

24kHz → 16kHz 重采样（2/3 polyphase）、静音修剪（阈值 0.01，保留 5ms padding）、
blocksize 切块 + 取消检查。

---

## 4. Pocket TTS（227 行）

- Kyutai Labs 模型，`TTSModel.load_model()`。
- **voice 三态**：预设名（alba/marius/javert/jean/fantine/cosette/eponine/azelma）、
  本地音频文件路径、`hf://` Hub 路径 → `get_state_for_audio_prompt` 加载音色状态。
- 默认 CPU、24kHz 生成 → 重采样到 16kHz。
- `min_time_to_debug` 覆写为 0.1s：小 chunk（10-20ms）不刷日志。

---

## 5. Facebook MMS（222 行）

- Transformers `VitsModel`，每语言一个模型文件。
- **语言映射表**：Whisper 风格语言码 → MMS 模型后缀（`en→eng`、`fr→fra`、`zh→cmn`…约 40 项）。
- **语言变化时热重载模型**（`load_model(language_code)`）——代价是切换语言有停顿。

---

## 6. 各后端共享的管线契约

```
process(TTSInput):
  1. speculative_turns.is_latest_after_reopen_grace 过滤过期回合
  2. speculative_turns.commit(turn, rev)  ← 回合在此提交!
     (之后 VAD 的重开不再接受, LLM 输出已定稿)
  3. 会话 voice override 应用 (Qwen3/Kokoro 支持)
  4. 合成 → 逐块 yield int16 (每块检查 cancel 代数)
  5. 回合结束 (EndOfResponse) → yield AUDIO_RESPONSE_DONE 哨兵

on_session_end(): 恢复初始 voice/语言/参考
```

**TTS 是回合提交点**：当合成真的开始时，speculative turn 被 commit——这保证
"打断窗口"只覆盖 LLM 生成阶段，TTS 一开播就不可撤销（可被 cancel 停掉但不再重开）。

---

## 7. 后端对比速查

| 后端 | 引擎 | 平台 | 流式 | 语言切换 | 特色 |
|---|---|---|---|---|---|
| `qwen3`（默认） | mlx-audio / faster-qwen3-tts | MPS / CUDA / CPU | ✅ | ✅ auto | 三模式（克隆/预设/设计）、会话 voice 动态切换 |
| `openai` | 远程 OpenAI 兼容端点（`/v1/audio/speech`） | 全平台 | ✅ | ❌（语言值原样透传） | 流式 PCM16/WAV 增量解码；默认 196ms 播放缓冲；见 [openai-compatible-tts.md](openai-compatible-tts.md) |
| `kokoro` | mlx-audio / 原生 kokoro | MPS / CUDA / CPU | ✅ | ✅ 自动换音色 | 8 语言预置音色 |
| `pocket` | pocket_tts | CPU / CUDA / MPS | ✅ | ❌ | 轻量、三态 voice、默认 CPU |
| `facebookMMS` | transformers VitsModel | CUDA / CPU | ✅ | ✅ 重载模型 | ~40 语言、MMS 模型按语言切换 |
| `supertonic` | Supertonic ONNX runtime | 全平台 | ✅ | ✅ 按句语言码，回退 `--supertonic_tts_lang` | 10 个内置音色（M1-M5/F1-F5），44.1kHz 输出下采样；模型缓存 `~/.cache/supertonic3/` |
| `omnivoice` | k2-fsa OmniVoice | CUDA / Intel XPU / MPS | ⚠️ 块式（非模型流式） | ❌ | 声音克隆（参考音频编码一次复用）；⚠️ 权重 CC-BY-NC 非商用 |
| `chatTTS` | ChatTTS | CUDA / CPU | ✅ | ❌ | 中文对话风格 |

---

## 8. 设计要点总结

1. **回合提交点**：TTS 开始合成 = speculative turn 的 commit 时刻，整个管线状态机在此收敛。
2. **流式贯穿**：所有后端都按 512 样本块产出（32ms），首音频延迟（TTFA）有日志监控，
   打断检查在每块粒度。
3. **引擎双轨**：Apple Silicon 一律 mlx-audio（全局 MLX 锁），其他平台各走各的优化引擎
   （faster-qwen3-tts / 原生 kokoro）。
4. **文本合并**：队列内按 `response_key` 合并同响应句子块（事件透传、音频一次合成），
   更连贯且保序（#453）。
5. **会话级 voice 覆盖**：客户端协议参数（voice）能动态改后端音色，会话结束自动复原。
6. **静音修剪 + preroll 保留**：去头部 ramp 但留 40ms 防切音，平衡延迟与音质。

---

*本文档随代码演进维护；如与源码行为不一致，以 `src/speech_to_speech/TTS/` 为准。*
