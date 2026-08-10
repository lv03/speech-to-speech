# VAD 模块详解

> 对应源码：`src/speech_to_speech/VAD/`（vad_handler.py / vad_iterator.py / smart_turn.py）
> 配套概念：`pipeline/speculative_turns.py`（推测性回合跟踪器）、`arguments_classes/vad_arguments.py`（参数）。

---

## 1. 模块组成

| 文件 | 行数 | 职责 |
|---|---|---|
| `vad_handler.py` | 844 | 主处理器：Silero 调用、回合管理、推测性重开、短段拼接、音频增强、事件发射 |
| `vad_iterator.py` | 170 | Silero VAD 的流式状态机封装（触发/结束检测、前缀缓冲、静音判定） |
| `smart_turn.py` | 153 | Smart Turn v3.2 ONNX 分类器：判断"这句话说完了吗" |
| `__init__.py` | 1 | 空 |

**定位**：管线第一站。输入是传输层切好的 16kHz PCM16 音频块（每块 512 样本 / 1024 字节），
输出是 `VADAudio`（完整的语音段），同时向侧信道发射 `SpeechStartedEvent` / `SpeechStoppedEvent`
（转成客户端的 `input_audio_buffer.speech_started/stopped` 事件）。

```
input_queue ──► VADHandler ──► spoken_prompt_queue (VADAudio)
                  │
                  └──► text_output_queue (SpeechStartedEvent/SpeechStoppedEvent)
```

---

## 2. 核心状态机：VADIterator（Silero 封装）

Silero VAD v5 模型对每个 30ms 窗口输出一个语音概率 `speech_prob`，`VADIterator.__call__` 逐块驱动它：

```
speech_prob >= threshold(0.6) 且未触发
   └─► triggered=True, 把 pre-speech 缓冲(最长 speech_pad_ms)作为前缀, 开始累积 buffer

已触发:
   speech_prob >= threshold - 0.15 (0.45)  → active_speech_samples += 块长 (记作"活跃语音")
   speech_prob <  threshold - 0.15         → 进入 temp_end 静音计时
        temp_end 持续 >= min_silence_ms → 回合结束, 返回整个语音段
```

**关键设计细节**：

- **双阈值滞回**（0.6 / 0.45）：进入语音需要高置信度，保持语音只需中置信度，
  避免抖动导致反复触发/退出。
- **`active_speech_samples`**：只统计"干净语音"样本（`prob >= 0.45`），是判断语音
  真实长度的依据，防止静音/噪声充数。
- **`speech_pad_ms` 前缀缓冲**：触发前保留最多 N ms 音频，触发后拼到段头，
  避免切断语音开头（默认 500ms，`_trim_pre_speech_buffer` 精确裁剪到 speech_pad_samples）。
- **`triggered` 属性**暴露给 Handler，作为"当前是否在说话"的状态查询。
- 支持 8kHz / 16kHz 采样率。

---

## 3. VADHandler 主流程（process 方法）

每块音频的处理顺序：

```
1. 解包 (bytes, RuntimeConfig) → _apply_runtime_turn_detection()
   └─ 客户端 session.update 可动态改 threshold / silence_duration_ms

2. should_listen 未置位 → 直接丢弃 (block_mic_during_playback / 打断窗口)

3. int16 → float32 → iterator(torch tensor)
   └─ 返回 None(仍在说话/静音) 或 list[tensor](语音结束段)

4. 触发检测: is_triggered_now 且未发过 speech_started
   └─ 检查活跃语音是否 >= min_speech_ms(384) → 确认回合 → 发射 SpeechStartedEvent

5. _process_realtime: 渐进式释放 + 回合结束处理
```

### 3.1 回合生命周期（turn_id / turn_revision）

VAD 为每个语音回合分配 `turn_id`（`turn_1`, `turn_2`...）与 `turn_revision`（重开则 +1）。
这套身份贯穿整个管线（STT → LLM → TTS），是**推测性回合**机制的基础。

### 3.2 渐进式实时转写（progressive mode）

说话过程中，每隔 `realtime_processing_pause`（默认 0.5s）把当前已累积的音频作为
`mode="progressive"` 的 `VADAudio` 释放给 STT，产生实时字幕。节奏随时长**自适应放大**：

```
说话时长 < 8s   → pause × 1
8s ~ 15s        → × 2
15s ~ 30s       → × 4
> 30s           → × 6 (封顶 2s)
```

回合结束再发一个 `mode="final"` 的完整段作为正式转写。

### 3.3 回合结束判定（final mode）

```
语音段返回时:
   active_speech < min_active_ms (或超 max_speech_ms)
     ├─ 短段可合并窗口内 → _hold_short_segment 暂存待拼接
     └─ 否则 → 丢弃 (视为噪声/误触发)
   通过 → 发射 SpeechStoppedEvent
        → SmartTurn 判定 → (可选) DeepFilterNet 增强
        → 与 speculative 前缀拼接 → yield VADAudio(mode="final")
        → speculative_turns.start_reopen_grace(...)
```

### 3.4 短段拼接（short_segment_merge_ms）

`min_silence_ms` 设得很小时（如 64ms），同一句话里的短暂停顿会把话切成多段。开启后：

- 活跃语音 < `min_speech_ms` 的段被**暂存**（`_PendingShortSegment`），等待下一段。
- 间隙 ≤ `short_segment_merge_ms` 时拼接，**中间补零还原声学间隙**，起始时间取第一段。
- 活跃语音 < 100ms 的碎片**永不暂存**（噪声防护，防多次小突发累计越过阈值误触发打断）。
- 超过合并窗口 → 丢弃。

---

## 4. 推测性回合：打断/重开的竞态解决

这是 VAD 最复杂的部分，与 `SpeculativeTurnTracker`（线程安全，Condition 同步）深度协作。
核心矛盾：**用户说完话 → LLM 开始生成 → 用户又补了一句话**，此时该把已生成的内容怎么办？

### 时间窗口机制

```
语音软结束 (final 发出) ──► 进入 reopen 宽限期
                              │
    ├─ speculative_reopen_ms (800ms, SmartTurn 说"说完了"时用)
    ├─ smart_turn_max_wait_ms (2000ms, SmartTurn 说"没说完"时用)
    │
    用户继续说话(音频时钟上的 gap ≤ 宽限) → 重开同一回合 (revision+1)
    超过宽限 / LLM 输出已提交 → 回合锁定, 新语音开新回合
```

### 重开流程（revision 递增）

```
语音重新开始:
  1. _begin_pending_reopen_if_needed → 在 tracker 登记 pending candidate
  2. 语音确认有效(active >= min_speech_continuation_ms=192, 宽松阈值)
  3. _confirm_pending_reopen → candidate 转正 → turn_revision+1
  4. 之前的 audio 前缀保留, 与新语音拼接 (_speculative_audio_prefix)
  5. 旧的 LLM/TTS 输出因 is_latest 检查失败被下游丢弃
```

- **`min_speech_continuation_ms`（192ms）**：重开回合的宽松判定阈值（滞回），
  正常新回合仍需满 384ms，避免补一句"嗯"就被误判成被打断的新回合。
- **`unanswered_reopen_ms`（7000ms）**：宽限期内 LLM 还没答复的回合，超时可继续重开
  （防"用户停顿但助手没回应"时把回合孤立）。
- **`observe()`**：VAD 每次分配 revision 都通知 tracker，下游
  （LMOutputProcessor、send loop）用 `is_latest_after_reopen_grace` 过滤过期输出。
- **提交（commit）**：LLM 输出被服务端采纳时 `commit`，之后该回合不再接受重开。

### 竞态处理

tracker 提供阻塞/非阻塞两族接口（`commit_if_latest_after_reopen_grace` vs
`try_commit...`），并有 2s 的 pending-reopen 等待超时——**pending candidate 未决时
下游必须等它落定**，防止"先确认了旧 revision 的转写、再冒出重开"的乱序。

---

## 5. Smart Turn 智能回合终结

Silero 找到"语音→静音"边界后，VAD 用 **pipecat-ai/smart-turn-v3 (v3.2)** ONNX 模型
判断用户**是否真的说完了**（声学+语言内容级判定，不只靠静音时长）。

```
语音段 → WhisperFeatureExtractor(最大 8s, 自动重采样到 16kHz)
      → onnxruntime CPU 推理
      → p = 说完的概率

p > threshold(0.5): complete → 用短的 speculative_reopen_ms(800ms) 宽限
p <= 0.5: incomplete → 用 smart_turn_max_wait_ms(2000ms) 宽限
                        + 延迟 STT/LLM 处理 smart_turn_incomplete_delay_ms(600ms)
                        (给用户补话的时间, 免得昂贵推理白跑)
```

- 模型从 `pipecat-ai/smart-turn-v3` 自动下载（可用 `smart_turn_model_path` 指本地文件，离线可用）。
- 推理失败时**回退**到普通 800ms 宽限，不阻塞管线。
- 采样率不匹配时用 `resample_poly` 重采样，不足 8s 补零。

---

## 6. 事件与输出

| 输出 | 时机 | 去向 |
|---|---|---|
| `SpeechStartedEvent` | 语音确认触发（活跃 ≥ min_speech_ms） | text_output_queue → `speech_started` 客户端事件 |
| `SpeechStoppedEvent` | 回合软结束 | 同上 → `speech_stopped` |
| `VADAudio(mode="progressive")` | 说话中周期性 | spoken_prompt_queue → 实时转写 |
| `VADAudio(mode="final")` | 回合结束 | spoken_prompt_queue → 正式转写 + 触发 LLM |

**superseded 清理**：enqueue 前用 `_drop_superseded_vad_audio` 清掉队列里已过期的
VADAudio（如重开后旧 revision 的 progressive 块），减少下游无用功。

---

## 7. 参数速查（`vad_arguments.py`）

| 参数 | 默认 | 含义 |
|---|---|---|
| `thresh` | 0.6 | Silero 语音概率阈值 |
| `min_silence_ms` | 64 | 判定回合结束所需连续静音 |
| `min_speech_ms` | 384 | 有效语音最小活跃时长 |
| `min_speech_continuation_ms` | 192 | 重开回合的宽松阈值（滞回） |
| `max_speech_ms` | ∞ | 单段语音上限（超限强制切分） |
| `speech_pad_ms` | 500 | 触发前保留并入段头的前缀音频 |
| `enable_realtime_transcription` | False | 渐进式实时转写 |
| `realtime_processing_pause` | 0.5s | 渐进释放间隔 |
| `speculative_reopen_ms` | 800 | 软结束回合的可重开宽限 |
| `unanswered_reopen_ms` | 7000 | 未答复回合的重开上限 |
| `short_segment_merge_ms` | 0 | 短段拼接窗口（0=关） |
| `smart_turn` | True | 启用 Smart Turn v3.2（`--no_smart_turn` 关闭） |
| `smart_turn_model_path` | None | 本地 ONNX 模型路径（默认从 Hub 下载） |
| `smart_turn_threshold` | 0.5 | Smart Turn 完成概率阈值 |
| `smart_turn_max_wait_ms` | 2000 | "未说完"时的推测宽限 |
| `smart_turn_incomplete_delay_ms` | 600 | "未说完"时延迟 STT/LLM 处理 |
| `smart_turn_cpu_count` | 1 | ONNX Runtime CPU 线程数 |

---

## 8. 设计要点总结

1. **延迟与准确率的平衡**：短静音（64ms）→ 低响应延迟但易碎段 → 用短段拼接+Smart Turn
   兜底；长静音 → 准但慢。默认值偏"快"（64ms），用后续机制补准确性。
2. **音频时钟而非墙钟**：重开窗口用 `audio_start_ms` 度量，客户端暂停推送音频时窗口冻结
   （推流式 vs 按住说话式行为一致）。
3. **双阈值 + 活跃采样计数**：`active_speech_samples` 是回合有效性的唯一依据，
   噪声防护（100ms 碎片不拼接）防误打断。
4. **推测性回合把竞态显式化**：turn_id/revision 贯穿全链，重开使旧输出自动作废，
   无需额外取消机制。
5. **会话隔离**：`on_session_end()` 全量重置内部状态（缓冲、计数器、tracker），
   配合 SESSION_END 软重置保证多会话不串台。

---

## 9. 与上下游的接口契约

| 上游 | 契约 |
|---|---|
| 传输层（WebSocket/WebRTC/audio_client） | `bytes` 或 `(bytes, RuntimeConfig)` 音频块 |
| `Service`（session.update） | 运行时动态调整 `turn_detection` 阈值/静音时长 |

| 下游 | 契约 |
|---|---|
| STT handler | `VADAudio`（含 `mode` / `turn_id` / `turn_revision` / `runtime_config`） |
| `text_output_queue` | `SpeechStartedEvent` / `SpeechStoppedEvent` |
| `SpeculativeTurnTracker` | `observe` / `begin_reopen_candidate` / `confirm_reopen_candidate` / `start_reopen_grace` |
| `should_listen` Event | 打断/播放期间由服务端控制是否接收新语音 |

---

*本文档随代码演进维护；如与源码行为不一致，以 `src/speech_to_speech/VAD/` 为准。*
