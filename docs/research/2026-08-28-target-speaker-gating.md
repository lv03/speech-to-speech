# 多人环境下的目标说话人门控：当前项目实施路线

日期：2026-08-28

## 结论

当前项目不应引入 `FLamefiREz/speaker-verification` 的代码或服务。它实际提供的是：用 CMGAN 对一段完整音频做单通道语音增强，再用 2023 年版本 3D-Speaker 的 **ERes2Net** 提取一个 192 维 embedding，并通过 Flask 返回 embedding。它没有流式状态、逐帧目标说话人概率、PVAD/TSE、混合说话人分离，也没有完整的注册、阈值校准和门控策略；README 还明确写着“仅供学习，不能用作商用”。这些事实可直接从其 [README](https://github.com/FLamefiREz/speaker-verification/blob/b972edbc341a8d1b9beb547b5d3caf5fa75de3cbf/README.md#L5-L13)、[embedding 实现](https://github.com/FLamefiREz/speaker-verification/blob/b972edbc341a8d1b9beb547b5d3caf5fa75de3cbf/Speaker/speakerlab/bin/infer.py#L19-L47)、[降噪后提 embedding 的封装](https://github.com/FLamefiREz/speaker-verification/blob/b972edbc341a8d1b9beb547b5d3caf5fa75de3cbf/verification.py#L7-L15) 和 [HTTP 接口](https://github.com/FLamefiREz/speaker-verification/blob/b972edbc341a8d1b9beb547b5d3caf5fa75de3cbf/verification_app.py#L56-L93) 核验。

当前项目已经使用同一技术路线的后继模型 **ERes2NetV2**：`Voiceprint.embed()` 通过 FunASR `AutoModel` 生成 192 维 `spk_embedding`，`VoiceprintProfile.score()` 做余弦相似度。因此引入上述仓库会重复已有能力，并倒退到旧版 ERes2Net；FunASR 官方教程也把当前模型定义为“独立 speaker embedding 提取 / diarization 的 speaker model”，不是 PVAD，见 [FunASR Speaker Verification / Diarization 教程](https://github.com/modelscope/FunASR/blob/main/docs/tutorial/README.md#speaker-verification--diarization-eres2netv2)。ERes2NetV2 的目标是增强短语音的说话人验证；论文报告 VoxCeleb1-O 的 full/3s/2s EER 分别为 0.61%/0.98%/1.48%，但这仍是**整窗 speaker verification**，不是“某一帧是否包含目标用户”，见 [ERes2NetV2 原论文](https://www.isca-archive.org/interspeech_2024/chen24l_interspeech.html)。

推荐分两期实施：

- **P0（现在做）**：复用现有 ERes2NetV2，在普通 VAD 内增加“渐进式滑窗 speaker verification 门控”。其直接目标是解决“只有别人说话时不打断、不转写、不响应”，也是现有代码改动最小、无需新增模型或许可证的路径；实际 FAR/FRR 仍需内部数据验收。
- **P1（有真实混合语音数据后）**：如果必须在目标人与他人同时讲话时判断“目标是否存在”，换成经过混合语音训练的 PVAD；如果还要求转写中去掉对方的话，则在 ASR 前增加 TSE。普通 SV 对混合波形只产生一个全局 embedding，不能把“混合窗分数低”解释为目标不在，也不能把“分数高”解释为只含目标声音。

### 能力、成熟度与许可判断

| 候选 | 实际能力 | 流式成熟度 | 对当前项目的许可/复用判断 |
|---|---|---|---|
| 当前 FunASR + ERes2NetV2 | 整窗 embedding + 余弦 SV；短语音优化 | 官方接口是整段 `generate()`；没有逐帧 PVAD 输出。可由本项目调度滑窗形成 P0，但不等于模型原生 streaming | 已是项目依赖；3D-Speaker 官方代码为 Apache-2.0，模型卡也标注 Apache-2.0。仍应在发布前保存模型卡/权重版本清单。见 [3D-Speaker 官方仓库](https://github.com/modelscope/3D-Speaker) 和 [ERes2NetV2 模型卡](https://modelscope.cn/models/iic/speech_eres2netv2_sv_zh-cn_16k-common)。 |
| `FLamefiREz/speaker-verification` | CMGAN 整段增强 + 旧 ERes2Net embedding HTTP 服务 | 无 streaming cache、帧级 target 输出或并发背压设计 | 顶层 `LICENSE` 是 MIT，但 README 又写“仅供学习，不能用作商用”，信号冲突；且没有技术增益，故不要复制或引入。 |
| Personal VAD / Personal VAD 2.0 | speaker-conditioned 帧级 target/non-target/non-speech | 论文明确面向实时/端侧；2.0 讨论量化与 ASR 集成 | 是研究设计与训练路线；未发现与本项目 encoder/runtime 可直接兼容的官方生产 checkpoint，不能按现成依赖估算工期。 |
| VoiceFilter-Lite | speaker-conditioned 流式 TSE，面向 ASR | Google 论文展示端侧实时与量化 | 论文/产品研究证明可行，不代表存在可直接引入的开放权重与商用 runtime。 |
| USEF-TSE / USEF-TP | TSE，或 TSE + PVAD 联合建模 | 研究实现/离线评测为主，不是当前仓库的即插即用组件 | 公开 USEF-TSE 仓库声明 CC BY-NC 4.0；商业项目不能未经许可采用其资产。 |

## 需求边界

本次已确认的产品语义是：

1. 别人单独讲话：系统不发 `speech_started`，不打断助手，不调用 STT/LLM，不响应。
2. 只要窗口中检测到目标用户，即放行这一整段；不修改或保存一份“删掉别人”的录音。
3. 目标用户与别人重叠讲话时，P0 只做“尽力检测并放行”，**不承诺** ASR 只识别目标用户；对方的词仍可能进入转写。

第 3 点是能力边界而非实现缺陷。Personal VAD 的原始工作把任务定义为逐帧三分类：`non-speech / target-speaker speech / non-target-speaker speech`，且其简单“普通 VAD + 普通 SV 分数”基线逊于专门训练的 PVAD，见 [Personal VAD 原论文](https://arxiv.org/abs/1908.04284)。Personal VAD 2.0 进一步把生产要求明确为流式、低延迟和端侧资源受限，见 [Personal VAD 2.0](https://arxiv.org/abs/2204.03793)。因此 P0 是有意选择的工程过渡方案，不应在文档或 UI 中称作“实时逐帧目标说话人检测”。

## 当前代码为什么会响应别人

当前数据流是：

```text
麦克风 PCM
  -> SecurityGateHandler（锁定时：唤醒词 + 一次声纹验证）
  -> VADHandler（解锁后：所有人的语音都进入）
  -> STT / audio-input LLM
  -> LLM / TTS
```

具体事实：

- `security/gate.py` 仅在 `_try_unlock()` 中验证唤醒词音频；解锁后 `process()` 对每个输入块直接 `yield item`，直到超时或会话结束。
- `VAD/vad_handler.py` 在达到 `min_speech_ms` 后立即发送 `SpeechStartedEvent`；实时字幕开启时还会周期性产生累计的 `VADAudio(mode="progressive")`，句末产生 `VADAudio(mode="final")`。
- `speech_started` 会触发 Realtime 的 barge-in/cancel。因此只在 VAD 与 STT 的音频队列之间增加一个过滤 Handler 仍然太晚：别人虽不会被转写，却已经打断了助手。

这决定了目标说话人判定必须在 `VADHandler` **发出 speech event 和 VADAudio 之前**生效，或由一个同时拥有这两类输出的上层组件接管；不能只拦截 `spoken_prompt_queue`。

## P0：复用 ERes2NetV2 的渐进式滑窗门控

### 组件边界

新增一个不依赖 VAD 内部状态的纯组件，例如 `security/speaker_gate.py`：

```python
class TargetSpeakerGate:
    def reset(self) -> None: ...
    def maybe_submit(self, audio: np.ndarray, *, is_final: bool) -> None: ...
    def poll(self) -> GateResult | None: ...

class GateResult(Enum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"   # 只在 final 或确定不可继续时返回
    ERROR = "error"
```

它复用已有 `Voiceprint` 和 `VoiceprintProfile`，不复制 FunASR 加载逻辑。模型、profile、阈值应在 `pipeline_graph.py` 中每个 pipeline 构建一次，并注入唤醒门和 VAD 门；若暂时不重构，也可先让 VAD 单独构建 verifier，但会多占一份模型内存，不建议作为最终结构。共享推理器要加互斥锁，因为 wake gate 与 VAD handler 是不同工作线程，不能假定第三方模型实例可重入。

`TargetSpeakerGate` 自己只负责：窗口调度、异步推理、最高分、状态和错误；它不分配 `turn_id`，不直接向 STT 或 event queue 写入。

### 状态与窗口

每个 Silero VAD segment 维护：

```text
idle -> pending -> accepted
               \-> rejected（仅段结束）
```

建议初始参数（必须用真实数据校准后再固化）：

- `first_check_ms = 800`：累计有效语音达到约 0.8 秒后首次验证。
- `retry_hop_ms = 500`：仍未通过时，每新增约 0.5 秒再验证。
- `window_ms = 1600`：每次取最近约 1.6 秒，避免长句推理成本随长度增长。
- `min_verify_ms = 500`：与当前 `Voiceprint.embed()` 的最低输入长度一致。
- 一段只允许一个 in-flight 推理；新音频到达时更新“下一待验证位置”，不排队堆积旧窗口。
- 任一窗口 `score >= threshold` 后，本段永久 `accepted`。句末仍未通过时，对尚未验证过的最终完整短段或最后一个窗口做一次最终验证；异常或超时采用 fail-closed。

选择 0.8/0.5/1.6 秒是延迟与现有 ERes2NetV2 短语音能力之间的工程起点，不是论文保证值。ERes2NetV2 的公开结果最低展示到 2 秒，而且 2 秒 EER 已高于完整语音；因此 0.8 秒窗口尤其需要设备内数据证明，不能直接把 VoxCeleb 数字外推到本项目。

### `VADHandler` 的精确接入点

当前 `VADHandler` 同时掌握 VAD buffer、speech events、progressive/final audio 和 speculative-turn 状态，所以 P0 应在这里接入：

1. `setup()` 新增可选 `target_speaker_gate`；未提供时，所有分支与现在完全一致。
2. `process()` 调用 `iterator` 后，从 `iterator.speech_buffer()` 取得当前累计段，驱动 `maybe_submit()` / `poll()`。
3. 现有“达到 active speech 阈值就 `_ensure_turn_for_speech_start()` 并发 `SpeechStartedEvent`”的分支，在声纹开启时额外要求 gate 已 `accepted`。`pending` 时不要分配/确认 turn、不要设置 `_speech_started_emitted`、不要 barge-in。
4. `_process_realtime()` 的 progressive yield 同样要求 `accepted`。首次接受时，发送从 VAD segment 原始起点开始的**完整累计 buffer**，这样不会丢掉验证前的句首；后续仍沿用现在的累计 progressive 语义。
5. VAD 结束时：
   - `accepted`：沿用当前 final、`speech_stopped`、smart-turn 和 speculative revision 流程。
   - `pending`：保留 final segment，完成最后一次验证后再决定；不能先发事件。
   - `rejected/error`：静默丢弃，取消尚未确认的 reopen candidate，清 gate 状态；不得设置 `_speculative_audio_prefix`、不得启动 reopen grace、不得产出 `VADAudio`。
6. `on_session_end()` 同时取消 future、递增 generation/token 并 reset gate，确保旧结果不能污染下一会话。

必须保留一个 segment generation id。异步结果回到 VAD 线程时，只有 id 与当前 pending segment 一致才能生效；否则 session reset、VAD 结束或下一段开始后的迟到结果会误放行错误音频。

### 异步执行

声纹推理放入每个 pipeline 一个 `ThreadPoolExecutor(max_workers=1)` 或等价的单 worker。音频接收仍写入原队列；VAD handler 不因模型推理而停止接收。需要明确：单 worker 的目标是“最多一个待处理窗口”，不是让每 500 ms 的历史窗口全部排队。队列积压会让验证结论落后于实时音频，最终反而更容易产生迟到 barge-in。

首次通过后不再验证本段，符合“只要检测到我就继续识别”。普通对话窗口不得用于自动更新 profile：混合语音可能污染模板。现有 `_adapt_profile()` 只保留在已通过的干净唤醒词路径。

### 注册与阈值必须调整

当前 CLI 让用户重复录制同一个唤醒词，适合唤醒阶段的 text-dependent-like 比对，但后续对话是任意文本。ERes2NetV2 本身是 text-independent speaker model；要让模板覆盖对话条件，应新增一次迁移/重新注册流程，录制多条 2–5 秒、不同内容的自然语音，并保存多个归一化 embedding 或其稳定 centroid。不要静默拿非目标/混合语音更新模板。

当前 `VoiceprintProfile.score()` 的文档声称范围 `[0, 1]`，但标准余弦相似度理论范围是 `[-1, 1]`；阈值也不能因为“同一句唤醒词接近 1”就直接用于任意文本滑窗。保留 `--voiceprint_threshold` 作为唯一用户参数可以减少配置复杂度，但上线值必须根据下述自有数据以业务 FAR 约束选择；建议在 profile 中记录 `purpose/model/version/enrollment_protocol`，避免旧唤醒词档案被无提示地当作 conversation-gate 档案。

### CMGAN 不应直接加入 P0

目标仓库里的 CMGAN 是普通单通道 speech enhancement：去噪、去混响或重建语音频谱，不以目标 speaker embedding 为条件。其原论文也把任务定义为 speech enhancement，而不是目标说话人提取，见 [CMGAN 原论文](https://www.isca-archive.org/interspeech_2022/cao22_interspeech.html)。因此它不能保证删掉另一位说话者，且增强造成的声纹特征偏移可能提高或降低 SV 分数。只有在“原始音频”和“增强后音频”用同一内部集合做了 FAR/FRR A/B 后，才应考虑把增强作为可选前端；本次 P0 不引入。

## P1：何时升级到 PVAD 或 TSE

### PVAD：检测目标用户是否正在说话

如果 P0 在重叠讲话中经常漏掉目标用户，下一步应训练/集成 speaker-conditioned PVAD，而不是继续缩短 ERes2NetV2 窗口。PVAD 输入是当前声学帧和注册 speaker 表征，输出 `target / non-target / non-speech` 的帧级概率；Personal VAD 论文明确说明专门模型优于把普通 VAD 与普通 SV 简单拼接。Personal VAD 2.0 证明了流式端侧方向，但论文没有提供一个与本项目 FunASR/ERes2NetV2 可直接插拔、可商用交付的官方 checkpoint。因此 P1 不是“pip install 后替换一行”，需要数据、训练、导出和 runtime 验证。

接入时，PVAD 应**替代或包裹 Silero VAD 的 speech 判定**，在现有 `speech_started` 之前产生目标语音状态；它不应仅作为 VAD 后整句分类器。仍可保留 ERes2NetV2 作为 enrollment encoder，但要确认 PVAD 训练时使用的 speaker embedding 分布与 ERes2NetV2 兼容，否则需要联合训练或适配层。

### TSE：从重叠语音中只保留目标用户

如果产品需求升级为“目标与他人同时讲话时，ASR 只识别目标用户”，PVAD 只告诉系统何时放行仍不够，必须在 ASR 前增加 target speaker extraction 或 target-speaker ASR。Google 的 [VoiceFilter-Lite](https://research.google/pubs/voicefilter-lite-streaming-targeted-voice-separation-for-on-device-speech-recognition/) 展示了 speaker-conditioned、端侧、流式 TSE 的正确任务定义；USEF-TP 则联合 TSE 与 PVAD 并专门评估重叠场景，见 [USEF-TP 论文](https://arxiv.org/abs/2501.03612)。这些工作证明路线可行，但不是当前依赖中的现成生产组件。公开的 [USEF-TSE 参考实现](https://github.com/ZBang/USEF-TSE) 使用 CC BY-NC 4.0 checkpoint/代码声明，不能未经许可直接用于商业产品。

TSE 的精确位置是：

```text
PCM ->（AEC/波束形成）-> target-conditioned TSE -> target/PVAD endpoint -> STT
```

不能把普通 CMGAN 当作 TSE。TSE 还需同时测 over-suppression：把目标词错误删掉通常比残留一些干扰词更伤 ASR；VoiceFilter-Lite 的论文也专门用非对称损失和自适应抑制处理这个问题。

## 测试计划与验收指标

### 确定性代码测试

使用 fake verifier，不依赖真实模型分数：

- 目标单独说话：首次或后续窗口通过；只在通过后出现一对 start/stop，首个 progressive 包含完整句首，final 进入 STT。
- 非目标单独说话：所有窗口失败；无 start/stop、无 progressive/final、无 STT/LLM、不中断正在播放的助手。
- 先非目标后目标：早期失败、后期通过；本段只发一次 start，并完整放行缓存。
- 目标 + 非目标混合（fake 分数通过）：整段放行。
- 短句在句末通过/失败；不足 0.5 秒拒绝。
- 推理异常、超时、迟到 future、session reset：fail-closed，旧结果不能放行下一段。
- speculative reopen：被拒绝段不能确认 reopen、递增 revision 或覆盖 prefix。
- 关闭 `--enable_voiceprint`：现有 VAD、实时字幕、barge-in 和 smart-turn 测试行为不变。
- wake word 仍只在锁定态验证；普通对话不自适应 profile；超时重新上锁仍通过。

### 声学评估集合

至少按以下维度分层，不要只用同一人同一麦克风的干净录音：

- target-only、non-target-only、target+non-target overlap、电视/手机播放人声、target+非语音噪声。
- 近讲/1m/3m，正面/侧面，安静/混响/风扇/音乐。
- 不同文本与唤醒词；短句 0.5–1s、1–2s、2–5s、长句。
- overlap 中目标相对干扰者的 SNR，例如 -5/0/+5 dB，以及目标在句首/句中/句尾才出现。
- 训练/校准/测试按说话人和录制 session 严格隔离；阈值只在 calibration split 上选。

### 核心指标

EER 只用于比较 speaker encoder，不作为产品验收。应同时报告：

| 指标 | 定义与目的 |
|---|---|
| Non-target utterance FAR | 只有非目标说话时，被 gate 接受的段比例；这是 P0 的首要安全指标。 |
| Target utterance FRR | 只有目标说话时，被 gate 拒绝的段比例。 |
| Target-present overlap recall | 混合窗中确有目标时被接受的比例；单独列 SNR、位置和距离。 |
| Target-absent overlap FAR | 多个非目标人重叠讲话时误接受的比例。 |
| Unauthorized Response Rate | 每 1000 个非目标段或每小时，真正触发 STT/LLM/助手响应的次数；覆盖整条链路。 |
| Acceptance latency P50/P95/P99 | 从 VAD speech onset 到 `speech_started`/首个 progressive 的时间。 |
| Non-target interruption count | 别人说话导致正在播放的助手被取消的次数；目标应为 0。 |
| STT call suppression | 非目标段避免的 progressive/final STT 调用比例。 |
| Overlap word intrusion rate | P0 放行混合段后，转写中来自非目标说话人的词比例；用于量化“放行但未分离”的局限。 |
| Runtime | 每窗口推理 P50/P95、实时因子、CPU/GPU、峰值内存、积压/丢弃窗口数。 |

阈值选择应先定可接受的 non-target FAR/Unauthorized Response Rate 上限，再在该约束下最小化 target FRR；不要直接使用 EER threshold。P0 上线前还应把当前默认 `0.75` 与多个候选阈值画成 DET/ROC，并按设备、距离、噪声和窗口长度分别报告。

## 建议的实施顺序

1. 先增加离线 score-harness：对现有 ERes2NetV2 在 0.8/1.2/1.6/2.0 秒窗口上跑自有 target/non-target/overlap 数据，验证 P0 是否达到业务 FAR/FRR。
2. 调整 enrollment 为多文本自然语音，并给 profile 加协议版本；用 calibration split 确定 threshold。
3. 实现 `TargetSpeakerGate`、VAD 内三态门控、异步单 worker 和 generation 防迟到。
4. 先完成 fake verifier 的行为测试，再跑真实模型集成测试和端到端“非目标不打断”测试。
5. 灰度时记录分数、判定、时延和原因，不记录原始音频或转写正文；观察 Unauthorized Response Rate 与 target FRR。
6. 只有 P0 的 overlap recall 不达标时才立项 PVAD；只有需要从转写中去除对方词时才立项 TSE。两者都应先审查 checkpoint/训练数据/代码许可证，再做 runtime 集成。

最终可交付的最小范围是 P0。它实现“别人单独说话不识别、不响应；某个滑窗检测到我就继续”的交互语义，但产品文案必须保留混合语音限制。`FLamefiREz/speaker-verification` 可作为“旧 ERes2Net + CMGAN 的实验案例”参考，不是应合并的依赖或实现基础。
