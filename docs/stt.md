# STT 模块详解

> 对应源码：`src/speech_to_speech/STT/`（base_stt_handler.py / parakeet_tdt_handler.py /
> whisper_stt_handler.py / faster_whisper_handler.py / lightning_whisper_mlx_handler.py /
> mlx_audio_whisper_handler.py / paraformer_handler.py / smart_progressive_streaming.py /
> transcription_notifier.py）。
> 配套概念：`pipeline/speculative_turns.py`（推测性回合）、[VAD 模块详解](vad.md)。

---

## 1. 模块组成

| 文件 | 行数 | 职责 |
|---|---|---|
| `base_stt_handler.py` | 213 | **基类**：推测性回合的过期输入/输出过滤（本模块灵魂） |
| `parakeet_tdt_handler.py` | 648 | **默认后端**：NVIDIA Parakeet TDT（MPS 走 MLX，CUDA/CPU 走 nano-parakeet） |
| `whisper_stt_handler.py` | 147 | Transformers Whisper（含 torch.compile 优化） |
| `faster_whisper_handler.py` | 68 | faster-whisper（CTranslate2） |
| `lightning_whisper_mlx_handler.py` | 108 | Lightning Whisper MLX（Apple Silicon） |
| `mlx_audio_whisper_handler.py` | 174 | mlx-audio Whisper（Apple Silicon） |
| `paraformer_handler.py` | 76 | FunASR Paraformer（中文向） |
| `smart_progressive_streaming.py` | 343 | 智能渐进式流式转写（句子感知窗口滑动） |
| `transcription_notifier.py` | 86 | STT 与 LLM 之间的桥接：发射协议无关转写事件 |
| `README.md` | — | 语言支持矩阵 |

**定位**：管线第二站。输入是 VAD 的 `VADAudio`（progressive 或 final 模式），
输出是 `Transcription`（进入 LLM）和 `PartialTranscription`（实时字幕）。

```
VADAudio ──► STT handler ──► stt_output_queue
                │              ├─ PartialTranscription → TranscriptionNotifier → 客户端 delta 事件
                │              └─ Transcription(最终)   → TranscriptionNotifier → LLM 触发
```

---

## 2. 基类：BaseSTTHandler — 推测性回合过滤器

所有 STT 后端继承它，核心职责是**在推测性回合（speculative turn）机制下保证 STT
输出不乱序**。由于打断/重开会递增 `turn_revision`，旧的 progressive/final 块必须被
丢弃，否则会把"已被修正"的语音转写发给 LLM。

### 2.1 输入过滤（`should_process_input`）

对每个 VADAudio 按序检查：

```
1. 已完成 final 的 revision 的输入 → 丢
   (同一 (turn_id, revision) 已产出过 final 转写, 不再处理)

2. progressive 块但队列里已有同 revision 的 final → 丢
   (final 已来, progressive 无意义)

3. 稳定性等待: final 块要等 reopen 宽限/稳定窗口结束
   is_latest_after_stability_window(turn, rev, max(settle_s, item_delay_s))
   └─ 给重开竞态一个"静置期", 防止刚发 final 就冒出重开
   └─ item_delay_s = processing_delay_s - 已等待时间(SmartTurn 延迟补偿)

4. 非最新 revision → 丢 (被重开取代了)
```

### 2.2 输出过滤（`should_emit_output`）

```
- PartialTranscription 属于已完成 final 的 revision → 丢
- 输出不是当前最新 revision → 丢 (仅等 pending-reopen, 不等稳定窗口)
```

### 2.3 队列内清理（`_drop_stale_queued_inputs`）

当检测到过期输入时，顺手**清掉输入队列里所有已过期的 VADAudio**（带 mutex 原子操作），
避免下游做无用推理。判定条件与输入过滤一致。

### 2.4 已完成 final 的 revision 追踪

`_completed_final_revision_keys`（OrderedDict，上限 2048，FIFO 淘汰）记录
"哪个 revision 已经出过 final"，防止重复处理；`on_session_end()` 清空。

> 基类这一套逻辑正是 #451「stop Whisper handlers finalizing turns on progressive audio」、
> #412「Whisper-family STT handlers ignore mode」等近期 issue/PR 的修复对象。

---

## 3. 各后端详解

### 3.1 Parakeet TDT（默认，648 行）

**双平台双引擎**：

| 平台 | 引擎 | 模型 |
|---|---|---|
| Apple Silicon (mps) | mlx-audio `load_model` | `mlx-community/parakeet-tdt-0.6b-v3` |
| CUDA/CPU | nano-parakeet（纯 PyTorch） | `nvidia/parakeet-tdt-0.6b-v3` |

**语言**：25 种欧洲语言，自动检测走 **lingua-py**（预加载模型，启动时构建 detector，
避免首次请求卡顿；短文本 < 20 字符不检测，太噪）。

**compute lock（关键）**：

- MLX 后端 → `MLXLockContext`（全局 MLX 锁，Metal 单命令队列，并发推理会崩进程）。
- nano-parakeet → 本地 `threading.Lock`。
- **progressive 用 10ms 短超时**（抢不到就跳过实时更新，不阻塞）；
- **final 用 5s 长超时**（必须完成）。

**实时转写集成**：开启 `enable_live_transcription` 时挂载
`SmartProgressiveStreamingHandler`。最终转写**复用渐进式已确认的句子**：
只对 `fixed_end_time` 之后的音频重新推理（`_process_mlx_final`），减少重复计算。

**语言回退链**：`用户指定 → 检测(≥20字符) → last_language(粘性)`，
检测结果不在支持列表则沿用上次语言。

### 3.2 Whisper（Transformers，147 行）

- 默认 `distil-whisper/distil-large-v3`，支持 `torch.compile`（static cache + CUDA graphs 预热）。
- **语言判定靠 token**：`pred_ids[0, 1]` 解码出 `<|xx|>` 语言 token；不在 12 语言支持列表
  则**用 last_language 重新生成一遍**（二次推理），并告警。
- 没有渐进式转写；`language_code` 在 auto 模式追加 `-auto` 后缀。

> #378「Whisper STT language detection reads a text token」正是修复这里
> 误把第一个文本 token 当语言 token 的 bug。

### 3.3 Faster-Whisper（68 行）

- CTranslate2 实现，`WhisperModel.transcribe` 直接透传 `gen_kwargs`。
- `adapt_gen_kwargs`：把 `return_timestamps` 转成 `without_timestamps`。
- 逐 segment 拼接文本；**不报语言**（对应 #423/#424 的 issue/PR）。

### 3.4 Lightning Whisper MLX（108 行）

- `LightningWhisperMLX`（batch_size=6），模型名取最后一段。
- auto 模式从返回 dict 取 `language`，不支持则用 last_language 重跑，再不行回退
  `{"text":"","language":"en"}`。
- 对应 #404/#405「auto 模式静默丢弃不支持的语音」的修复对象。

### 3.5 MLX Audio Whisper（174 行）

- 默认 `mlx-community/whisper-large-v3-turbo`；processor 缺失时从 OpenAI 原版模型映射加载。
- **所有推理包在 `MLXLockContext` 里**（注释明确写了不锁会崩进程：
  "Completed handler provided after commit call"）。
- `_resolve_language`：强制语言优先 → 检测语言（支持列表校验）→ 粘性 last_language → `en`。
- auto 模式同样追加 `-auto`。

### 3.6 Paraformer（76 行）

- FunASR `AutoModel`，默认 `paraformer-zh`（中文向）。
- 无独立语言参数，依赖模型能力。

---

## 4. TranscriptionNotifier — STT 与 LLM 的桥

不产文本，只做两件事：

```
PartialTranscription → PartialTranscriptionEvent(delta) → text_output_queue
                        └─ 客户端收到 conversation.item.input_audio_transcription.delta

Transcription → ① TranscriptionCompletedEvent(transcript, language, turn_id...) → text_output_queue
                ② 空文本 → 不发 LLM, 只恢复 should_listen (关闭输入闸)
                ③ 非空 → 进入 text_prompt_queue → LLM (通过 service 的后续处理)
```

关键点：**空 final 转写也要发 completed 事件**（客户端可能已收到 partial deltas，
需要收尾），但不触发 LLM。

---

## 5. SmartProgressiveStreamingHandler — 智能渐进式转写

解决"边听边转写"的准确率/延迟矛盾，核心策略：

```
1. 每 500ms 发一次部分转写
2. 窗口增长到 15s (max_window_size) 前, 重转写整个窗口 → 上下文充分, 准确率高
3. 超过 15s:
   └─ 把 2s (sentence_buffer) 之前已完成的句子 "固定" (fixed_sentences)
   └─ 只重转写固定点之后的活跃窗口 → 控制计算量
   └─ 固定点按句子边界切 (句尾时间戳), 不会切半句
```

输出 `PartialTranscription(fixed_text, active_text, timestamp, is_final)`：

- `fixed_text`：已确认不再变的句子（客户端可安全展示）
- `active_text`：当前可能被修改的部分（客户端应作为临时字幕）

最终转写时，Parakeet 只推理 `fixed_end_time` 之后的新音频，再拼接 fixed 文本——
**渐进式推理的成果被复用，用户说完话的瞬间结果就已就绪**。

---

## 6. 与 VAD 的协作契约

| 契约 | 说明 |
|---|---|
| `mode` | `progressive`（实时字幕）/ `final`（正式转写触发 LLM） |
| `turn_id` / `turn_revision` | 回合身份，基类据此过滤过期输入 |
| `processing_delay_s` | SmartTurn 延迟补偿：final 块等待稳定窗口时扣除已延迟的时间 |
| `speech_stopped_at_s` | 传入 `Transcription.speech_stopped_at_s` 供下游计时 |

---

## 6.1 实时转写（Live Transcription）支持情况

> ⚠️ **重要区分**：VAD 层的渐进式音频释放（`enable_realtime_transcription` /
> `--enable_live_transcription`）对**所有** STT 后端都生效——开启后 VAD 会周期性
> 释放 `mode="progressive"` 的音频块。区别只在于 **STT handler 收到 progressive 块后
> 如何处理**，以及能否产出 `PartialTranscription`（客户端实时字幕）。

### 后端支持矩阵（实测代码核实）

| 后端 | 处理 progressive？ | 实现方式 | 实时字幕 |
|---|---|---|---|
| `parakeet-tdt`（默认） | ✅ **完整实现** | SmartProgressiveStreaming 增量式：句子固定 + 只重转写活跃窗口，final 复用固定句子 | ✅ 高质量 |
| `paraformer` | ✅ **朴素实现** | 每个 progressive 块直接全量 `model.generate`，产出 `PartialTranscription`（无句子固定/复用） | ✅ 可用（计算量线性增长） |
| `whisper`（Transformers） | ❌ **忽略 mode（bug）** | 无 mode 分支，progressive 块被直接转写并 yield `Transcription`（final 级别） | ❌ 会误触发回合终结 |
| `faster-whisper` | ❌ **忽略 mode（bug）** | 同上 | ❌ 会误触发回合终结 |
| `lightning-whisper-mlx` | ❌ **忽略 mode（bug）** | 同上 | ❌ 会误触发回合终结 |
| `mlx-audio-whisper` | ❌ **忽略 mode（bug）** | 同上 | ❌ 会误触发回合终结 |

### 代码依据

**paraformer**（区分 mode）：

```python
if vad_audio.mode == "progressive":
    yield PartialTranscription(...)   # 实时字幕
else:
    yield Transcription(...)          # 最终转写
```

**whisper 系**（无 mode 分支，一律当最终转写）：

```python
def process(self, vad_audio):
    pred_ids = self.model.generate(...)   # 不管 mode 直接转写
    yield Transcription(...)              # 一律 yield Transcription
```

### 影响与现状

1. **parakeet-tdt** 是唯一"高质量增量式"实现——渐进式成果（固定句子）被最终转写复用，
   用户说完话瞬间结果就绪（见第 5 节）。
2. **paraformer** 是"朴素渐进式"——能出实时字幕，但每次全量重算，final 时还要再全量跑一次。
3. **whisper 系 4 个后端**：开启 live transcription 时，VAD 照常释放 progressive 块，
   但这些 handler 会把每个 progressive 块**误当最终转写**产出 `Transcription`，导致
   **过早回合终结**（premature turn finalization）——这是 issue **#412**
   「Whisper-family STT handlers ignore mode」描述的问题；PR **#451**（截至 2026-08 仍 open）
   正在修复：让它们跳过 progressive 块、只处理 final。修复后这些后端将**只有最终转写、
   无实时字幕**。
4. **Apple Silicon 前提**：`num_pipelines > 1` 时 live transcription 会被自动禁用
   （MLX 全局锁竞争，见 `s2s_pipeline.run_pipeline_command`），与 STT 后端无关。

---

## 7. 设计要点总结

1. **推测性回合过滤是 STT 的核心复杂度**：不是"转写准不准"，而是"转写是否属于当前
   有效回合"。基类四层过滤（已完成 final / progressive 重复 / 稳定窗口 / 非最新
   revision）+ 队列原子清理。
2. **MLX 并发安全**：所有 MLX 路径必须串行（全局锁），progressive 抢不到就跳过
   （短超时 10ms），final 必须等到（5s）。
3. **语言处理双策略**：Whisper 系靠 token/结果字段检测，Parakeet 靠 lingua-py 文本
   检测；都有"粘性 last_language"回退 + 支持列表校验 + 二次推理兜底。
4. **渐进式与最终式复用**：SmartProgressiveStreaming 把"已固定句子"传给最终转写，
   避免重复推理，实现"零延迟最终结果"。
5. **空转写安全**：空 final 仍发 completed 事件、恢复 should_listen，但不触发 LLM。

---

## 8. 后端对比速查

| 后端 | 引擎 | 平台 | 实时转写 | 语言检测 | 备注 |
|---|---|---|---|---|---|
| `parakeet-tdt`（默认） | mlx-audio / nano-parakeet | MPS / CUDA / CPU | ✅ 完整增量式（见 6.1） | lingua-py（25 语） | 欧洲语言 |
| `whisper` | Transformers | CUDA / CPU | ⚠️ 忽略 mode（#412，见 6.1） | token（12 语） | 支持 torch.compile |
| `faster-whisper` | CTranslate2 | CUDA / CPU | ⚠️ 忽略 mode（#412） | 不报告 | 最快 |
| `whisper-mlx` | LightningWhisperMLX | Apple Silicon | ⚠️ 忽略 mode（#412） | 结果字段（12 语） | |
| `mlx-audio-whisper` | mlx-audio | Apple Silicon | ⚠️ 忽略 mode（#412） | 结果字段（12 语） | 全局 MLX 锁 |
| `paraformer` | FunASR | CUDA / CPU | ✅ 朴素全量式（见 6.1） | 模型相关 | 中文向 |
| `none` | — | — | — | — | 音频直接进多模态 LLM |

---

*本文档随代码演进维护；如与源码行为不一致，以 `src/speech_to_speech/STT/` 为准。*
