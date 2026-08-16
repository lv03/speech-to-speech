# 安全门卫：唤醒词 + 声纹（Security Gate）

在 VAD 之前插入一个安全门卫：系统默认「上锁」，任何人说话都不会被处理（静默不响应）。
只有**已注册说话人说出唤醒词**后才会解锁，进入正常对话；解锁后助手会语音确认一句
（默认「我在，请说。」），随后会话结束、或麦克风安静超过超时时间后自动重新上锁。

```
浏览器 → WS /v1/realtime → [安全门卫] → VAD → STT → LLM → TTS
                              │
                   上锁时吞掉所有音频，只跑:
                   ① 唤醒词检测 (sherpa-onnx zipformer KWS)
                   ② 声纹验证 (3D-Speaker ERes2NetV2)
                   上锁期间连文本输入/开场问候也会被服务端丢弃
```

## 1. 模型与预热

| 组件 | 引擎 | 模型 | 加载时机 |
|---|---|---|---|
| 唤醒词 | sherpa-onnx（`pip install sherpa-onnx`） | `pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`（ModelScope，~15MB） | 服务启动时 |
| 声纹 | funasr（已随 `[paraformer]` 安装） | `iic/speech_eres2netv2_sv_zh-cn_16k-common`（ModelScope，~100MB） | **服务启动时预热**（构建流水线阶段） |
| 分句 SaT | wtpsplit | `sat-3l-sm` | **服务启动时预热**（避免重启后第一句对话变慢） |

三个模型全部在启动阶段完成加载/预热：启动多花几秒，换来**对话过程中零冷启动**。
唤醒词 KWS 的解码流每 30 秒才重置一次（避免唤醒词被拦腰截断），单次检测毫秒级；
声纹验证每次约 0.1s。

## 2. 注册声纹（CLI，麦克风）

```bash
speech-to-speech voiceprint enroll --name default --takes 3
```

按提示在倒计时后说出唤醒词「噜噜噜噜」3 遍，每遍录音会经过与实时验证**完全相同的
固定 1.6s 裁剪**后取平均 embedding，保存到
`~/.cache/speech_to_speech/voiceprint/default.npz`。

> 注意：裁剪算法有更新（固定 1.6s 窗口）。升级代码后请**重新注册**，旧档案的分数
> 会偏低。

其他子命令：

```bash
speech-to-speech voiceprint verify           # 录一遍，打分并给出通过/拒绝
speech-to-speech voiceprint info              # 查看档案元信息
```

## 3. 启动服务（带门卫）

```bash
speech-to-speech serve \
  --enable_wake_word \
  --wake_word 噜噜噜噜 \
  --enable_voiceprint \
  --voiceprint_enrollment ~/.cache/speech_to_speech/voiceprint/default.npz \
  --voiceprint_threshold 0.60 \
  --security_timeout_s 60 \
  ...其他后端参数
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--enable_wake_word` | off | 总开关；不开启时行为与原来完全一致 |
| `--wake_word` | `噜噜噜噜` | 唤醒词显示文本 |
| `--enable_voiceprint` | off | 在唤醒词音频上验证声纹（需要先 `voiceprint enroll`） |
| `--voiceprint_enrollment` | `~/.cache/speech_to_speech/voiceprint/default.npz` | 声纹档案路径 |
| `--voiceprint_threshold` | `0.75` | cosine 相似度阈值（0,1]，越高越严格。实测真人建议 `0.60` 起，配合自适应逐步收紧 |
| `--security_timeout_s` | `60` | 麦克风安静这么多秒自动重新上锁（任何可闻声音都会重置计时） |
| `--unlock_acknowledgment` | 一句"确认你在听"的提示语 | 解锁后注入给 LLM 的确认提示；设为空字符串则解锁后保持静默 |

只开启 `--enable_wake_word` 不开启声纹 = 纯唤醒词模式（任何人说对唤醒词即可用）。

## 4. 行为细节

- **上锁时静默**：音频被吞掉，VAD/STT/LLM 完全看不到；服务端同时丢弃 `response.create`
  （demo 的开场问候、注入文本都走这条路），所以**文本路径也无法绕过门卫**。
- **唤醒词不泄漏**：唤醒词音频不会进入 STT，不会被当成一句话转写。
- **解锁确认**：解锁瞬间服务端自动注入确认提示 → LLM 生成「我在，请说。」→ TTS 播放。
  走正常的事件/音频链路，浏览器无需改动。
- **验证对象**：检测器从音频流中截取**固定 1.6s 窗口**（右对齐到语音结束 +0.3s，
  不足前面补静音），注册用同一窗口——同长度同上下文，embedding 分数稳定。
- **声纹自适应**：每次验证通过，把本次 embedding 以 15% 权重并入档案并保存；
  用得越多，分数越向你的实时声音收敛。
- **重新上锁**：① 客户端会话结束；② 麦克风连续安静超过 `--security_timeout_s`
  （对话中说话/助手声音都会重置计时，不会再出现"聊到一半被锁"）。

## 5. 已知限制

- **「噜」的声调**：唤醒词 KWS 模型在 WenetSpeech 上训练，一声 `lū` 语料极少、识别不稳；
  模块因此注册了全部声调变体（`l ū/l ù/l u/l ú/l ǔ`），无论怎么念都能触发，代价是「路路路路」
  等同音词也可能触发（会被声纹拦下，或者纯唤醒词模式下误触发——可按需删减
  `WakeWordDetector` 的 `variants`）。
- **固定窗口的裁剪前提**：唤醒词前后最好有自然停顿；紧贴长句说话时窗口内容会混入
  前文，分数偏低而拒绝（fail-closed，重说一遍即可）。
- **安全边界**：这是应用级软安全，防「别人顺口用一下」，不防拿到机器/能直接调 API 的人。
- **调阈值经验**：注册后跑 `voiceprint verify` 看分数，实时使用的分数会略低于干净录音；
  建议阈值设在"verify 分数 −0.05~0.10"处，再靠自适应逐步收敛。
