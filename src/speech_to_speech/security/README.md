# 安全门卫：唤醒词解锁 + 持续声纹门控（Security Gate）

系统默认「上锁」：说出唤醒词即可解锁（唤醒词本身**不验证声纹**）。解锁后启用持续声纹
门控——每一段语音在发出 `speech_started`、进入 STT 或触发 LLM 之前，都必须先确认这段语音
里包含已注册用户。非目标说话人单独讲话会被静默丢弃，既不打断助手，也不产生转写或响应。

```
上锁时:
浏览器 → WS /v1/realtime → [唤醒词检测] → 吞掉音频（不进入 VAD/STT/LLM）

解锁后:
浏览器 → WS /v1/realtime → VAD 累积语音 → [滑动窗口持续声纹门控]
                                    ├─ 通过：发 speech 事件 → STT → LLM → TTS
                                    └─ 拒绝：静默丢弃整段，不发事件/转写/响应
```

## 1. 模型与预热

| 组件 | 引擎 | 模型 | 加载时机 |
|---|---|---|---|
| 唤醒词 | sherpa-onnx（`pip install sherpa-onnx`） | `pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`（ModelScope，~15MB） | 服务启动时 |
| 声纹 | funasr（已随 `[paraformer]` 安装） | `iic/speech_eres2netv2_sv_zh-cn_16k-common`（ModelScope，~100MB） | **服务启动时预热**（构建流水线阶段） |
| 分句 SaT | wtpsplit | `sat-3l-sm` | **服务启动时预热**（避免重启后第一句对话变慢） |

唤醒词检测不加载声纹模型；持续声纹门控加载一份 ERes2NetV2 验证器。声纹推理在每
pipeline 的单 worker 线程上执行，音频接收不因模型推理而中断。

## 2. 注册声纹（CLI，麦克风）

```bash
speech-to-speech voiceprint enroll --name default
```

默认录制 **5 段、每段 4 秒**的自然语音（约 20 秒）。按提示在倒计时结束后朗读屏幕上
的句子即可；不同文本能更好地覆盖后续自由对话，而不是只记住唤醒词。每条录音会被
归一化后取等权 centroid，保存为
`~/.cache/speech_to_speech/voiceprint/default.npz`。

`--wake-word` 仍会写入档案，但只是安全门卫的唤醒词元数据，不再是注册时必须朗读的句子。
可用 `--take-duration`（2–10 秒）调整单段时长。

其他子命令：

```bash
speech-to-speech voiceprint verify           # 录一段自然语音，打分并给出通过/拒绝
speech-to-speech voiceprint info              # 查看档案元信息与是否支持持续门控
```

> 旧版「重复录唤醒词」档案（协议 `legacy_wake_word_v1`）仍可被 `info` 查看，但不会用于
> 持续门控。启用 `--enable_voiceprint` 前请先重新注册。

## 3. 启动服务（带门卫）

```bash
speech-to-speech serve \
  --enable_wake_word \
  --wake_word 你好，噜噜 \
  --enable_voiceprint \
  --voiceprint_enrollment ~/.cache/speech_to_speech/voiceprint/default.npz \
  --voiceprint_threshold 0.60 \
  --security_timeout_s 60 \
  ...其他后端参数
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--enable_wake_word` | off | 唤醒词解锁（纯检测，不验证声纹）；不开启时麦克风直通 VAD |
| `--wake_word` | `你好，噜噜` | 唤醒词显示文本 |
| `--enable_voiceprint` | off | 持续声纹门控；与 `--enable_wake_word` 相互独立，要求档案为自然语音注册 |
| `--voiceprint_enrollment` | `~/.cache/speech_to_speech/voiceprint/default.npz` | 声纹档案路径 |
| `--voiceprint_threshold` | `0.75` | cosine 相似度阈值（0,1]，越高越严格；上线值应从自有 target/non-target/overlap 录音中校准 |
| `--security_timeout_s` | `60` | 麦克风安静这么多秒自动重新上锁（任何可闻声音都会重置计时） |
| `--unlock_acknowledgment` | `我在，请说。` | 解锁后注入给 LLM 的确认提示；设为空字符串则解锁后保持静默 |

`--enable_wake_word` 与 `--enable_voiceprint` 相互独立：可以只开唤醒词、只开声纹门控，或两者都开。
开启声纹门控后，解锁（若配置了唤醒词）之后每段语音仍会做声纹过滤。

## 4. 行为细节

- **上锁时静默**：音频被吞掉，VAD/STT/LLM 完全看不到；服务端同时丢弃 `response.create`
  （demo 的开场问候、注入文本都走这条路），文本路径也无法绕过门卫。
- **持续门控在 VAD 内生效**：一段语音从约 0.8 秒开始做首次声纹验证，未通过时每新增约
  0.5 秒取最近约 1.6 秒窗口重试。任一窗口通过即放行整段（含验证前的句首），否则整段丢弃。
- **别人单独说话不打断**：非目标段不会发出 `speech_started`/`speech_stopped`，不会取消正在
  播放的助手，也不会进入 STT 或 LLM。
- **混说限制**：声纹不分离音轨。你与别人同时说话时，只要某窗口检测到你就放行，但转写仍
  可能包含对方重叠的词。需要「转写中只保留你」时应另外引入 target-speaker extraction。
- **唤醒词不泄漏**：唤醒词音频不会进入 STT。
- **声纹档案不随对话自适应**：普通对话窗口（可能含他人）绝不更新档案，避免污染模板。
- **重新上锁**：① 客户端会话结束；② 麦克风连续安静超过 `--security_timeout_s`。

## 5. 已知限制

- **不是逐帧 PVAD**：P0 复用整窗 speaker embedding。若真实 overlap 数据表明持续门控经常漏掉
  目标用户，应升级为 speaker-conditioned PVAD。
- **首句延迟**：声纹启用后，第一句的语音事件/字幕约延后 0.8–1.1 秒；通过后实时字幕恢复正常。
- **阈值必须实测**：`0.75` 是默认起点，不是保证值。用离线校准脚本在近讲/远讲/噪声/电视背景/
  多人重叠数据上选阈值。
- **安全边界**：这是应用级软安全，不防重放/TTS/变声攻击，也不应作为高风险指令的唯一凭据。

## 6. 离线校准

```bash
uv run python scripts/evaluate_voiceprint_gate.py \
  --profile ~/.cache/speech_to_speech/voiceprint/default.npz \
  --manifest ./voiceprint-eval/manifest.jsonl \
  --threshold 0.60 --threshold 0.65 --threshold 0.70 \
  --window-ms 800,1200,1600,2000 \
  --hop-ms 500 \
  --output ./voiceprint-eval/report.json
```

manifest 每行一个 JSON 对象：

```json
{"audio_filepath":"audio/non_target_001.wav","label":"non_target","target_present":false}
```

`label` 取 `target`、`non_target` 或 `overlap`；`overlap` 需通过 `target_present` 区分是否含目标。
