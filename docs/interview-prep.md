# 面试准备清单 —— 数字人语音对话模块项目

> 目标岗位：大模型/AI 应用开发 · 1-3 年
> 用法：按"六周路线"逐项打勾，每项掌握标准达到后再进下一项；配合 grilling 演练验收。
> 配套：`resume-project.md`（简历条目）、docs/ 下 9 份技术文档（参考材料）。

---

## 一、掌握矩阵（知识域 × 优先级）

| 知识域 | P0 必背 | P1 重点 | P2 加分 |
|---|---|---|---|
| 语音与音频 | 语音基础概念 | VAD/ASR 渐进式/TTS 变体 | 音频处理细节（重采样/修剪） |
| 大模型与应用 | 流式与工具调用 | 多后端差异 / reasoning | 量化 / 上下文管理 |
| 系统架构与并发 | 线程模型 / 打断一致性 | 可插拔 / 会话隔离 / MLX 锁 | 会话生命周期细节 |
| 网络与协议 | Realtime 为什么 | WS vs WebRTC / 协议差异 | 协议演进（#453） |
| 部署与推理 | — | llama.cpp / vLLM / MLX / 缓存 | RTF-TTFA / 离线部署 |
| 项目细节与身份 | 切换经历 / 身份边界 | 后端名单 / 启动命令 / 数据溯源 / demo | 工具链 |

---

## 二、详细清单（每项：主题 → 掌握标准 → 关联简历 → 参考）

### A. 语音与音频

| 主题 | 掌握标准（验收） | 关联简历 | 参考 |
|---|---|---|---|
| A1 语音基础概念 | 能讲清采样率/位深/PCM16/base64；为什么输入 16kHz、输出 24kHz；16k→24k 重采样发生在哪 | 语音链路 | docs/protocol §3、tts §3.3 |
| A2 VAD 原理 | 能讲 Silero VAD 阈值/双阈值滞回/静音判定；为什么 min_silence 64ms + Smart Turn 兜底 | 智能回合终结 | docs/vad §2、§5 |
| A3 ASR 渐进式转写 | 能讲 progressive/final 双模式；固定句子复用机制；为什么"说完瞬间出结果" | 零重复推理 | docs/stt §5、vad §3.2 |
| A4 TTS 三种变体 | 能讲 Base（须克隆）/CustomVoice（预设音色）/VoiceDesign（指令控语调）差异与适用场景 | 多音色 | docs/tts §2.2 |
| A5 音频处理细节 | 能讲静音修剪+preroll、重采样（24k→16k polyphase）、blocksize 切块 | 低延迟 | docs/tts §2.3、§3.3 |

### B. 大模型与应用

| 主题 | 掌握标准（验收） | 关联简历 | 参考 |
|---|---|---|---|
| B1 LLM 流式生成 | 能讲自回归/KV Cache/流式 token；为什么按句子分批（3 句一批）下发 TTS | 句子分批 | docs/llm §4 |
| B2 工具调用闭环 | 能画 function calling 多轮时序；能讲竞态防护（提前入史/重注入/事务化回滚） | Agent 能力 | docs/llm §5、architecture §7.4 |
| B3 多后端差异 | 能对比 transformers / llama.cpp(GGUF) / vLLM / MLX 的格式、接口、适用平台 | 双 LLM 后端 | docs/backend-registry §4 |
| B4 reasoning 机制 | 能讲 Qwen3 思考开关：`chat_template_kwargs.enable_thinking` / `--reasoning off` / reasoning_effort 各层作用；实测差异 | 参数调优 | docs/llm §11、protocol §8 |
| B5 量化格式 | 能对比 GGUF Q4/Q8 vs MLX 6bit vs BF16（体积/精度/目标硬件） | 模型接入 | docs/architecture §5.3 |
| B6 上下文管理 | 能讲滑动窗口驱逐、LLM 摘要压缩、按 response_key 事务化回滚 | 长会话稳定 | docs/llm §6 |

### C. 系统架构与并发

| 主题 | 掌握标准（验收） | 关联简历 | 参考 |
|---|---|---|---|
| C1 线程 vs asyncio | 能讲推理是 CPU 密集阻塞、asyncio 管不了；混合架构（网络层 asyncio + 推理层线程 + 队列桥接）；GIL 在推理库中释放 | 线程化流水线 | docs/architecture §2、pipeline-infra §5 |
| C2 打断一致性 | 能画打断时序；讲清推测性回合（turn_id/revision）+ 代数式取消 + Smart Turn 宽限 | 智能打断 | docs/vad §4、pipeline-infra §6-7 |
| C3 多后端可插拔 | 能讲 BackendSpec + 能力标记（bypasses_notifier/audio_input/llm_proxy）；加后端要改什么 | 可插拔架构 | docs/backend-registry §2-3、§7 |
| C4 多会话隔离 | 能讲 PipelineUnit 池（状态深拷贝）；SESSION_END 全链软重置 + 超时隔离（quarantine） | 多会话隔离 | docs/realtime-api §5、architecture §4 |
| C5 MLX 并发安全 | 能讲单一 Metal 命令队列为何崩（"Completed handler provided after commit call"）；全局锁 + 差异化超时 | 资源竞争 | docs/pipeline-infra §8.2 |
| C6 会话生命周期细节 | 能讲 claim→register→drain→release→quarantine 全流程；为什么释放要等 SESSION_END 传播 | 状态管理 | docs/realtime-api §5.1、§9 |

### D. 网络与协议

| 主题 | 掌握标准（验收） | 关联简历 | 参考 |
|---|---|---|---|
| D1 Realtime 协议为什么 | 能讲 5 点（生态标准/能力完备/前后端解耦/双通道/迁移红利） | 协议兼容层 | resume-project 面试表、docs/protocol §8 |
| D2 WebSocket vs WebRTC | 能讲本质差异（TCP 消息 vs UDP/SRTP 媒体轨道）；base64 开销；ICE/TURN；为什么并存（5 点）；实现差异点 | 双通道 | docs/protocol §2、§6 |
| D3 协议与标准差异 | 能列出与 OpenAI 标准差异（output_audio 命名/GA schema/done 结构/session.updated） | 协议兼容层 | docs/protocol §6 |
| D4 事件表 | 能报出客户端→服务端 7 事件、服务端→客户端主要事件及其含义 | 联调 | docs/protocol §4-5 |

### E. 部署与推理

| 主题 | 掌握标准（验收） | 关联简历 | 参考 |
|---|---|---|---|
| E1 llama.cpp 部署 | 能报出 llama-server 启动命令与关键参数（-m/-c/--port/--reasoning/--chat-template-kwargs）；GGUF 从哪来 | llama.cpp 接入 | 经验（对话记录） |
| E2 vLLM 部署 | 能讲 vLLM OpenAI 兼容端点（/v1/models、/v1/chat/completions、/v1/responses）；模型名与 served-model | vLLM 接入 | 经验 |
| E3 MLX 部署 | 能讲 mlx-audio/mlx-lm 加载、MLX 转换权重必要性、mps 设备 | MLX 路径 | docs/tts §2、stt §3.1 |
| E4 ModelScope/HF 缓存 | 能讲缓存目录结构（~/.cache/modelscope/models/...snapshots）、环境变量（HF_HOME/MODELSCOPE_CACHE）、离线部署思路 | 全本地化 | 经验 |
| E5 RTF/TTFA 指标 | 能定义 RTF（实时率）与 TTFA（首音频延迟）；报出实测值（TTFA 0.3s 级、TTS RTF~1-2） | 0.3s 延迟 | docs/tts §2.3 |

### F. 项目细节与身份

| 主题 | 掌握标准（验收） | 关联简历 | 参考 |
|---|---|---|---|
| F1 模型切换经历 | 能讲 3 段真实切换（STT Parakeet→Paraformer、LLM llama.cpp→vLLM、TTS 变体）含坑与解决 | 模型选型 | 对话记录（resume 下方速记卡待补） |
| F2 身份与边界 | 能答：数字人项目负责语音模块；视觉/口型由团队负责；参考开源方案但选型/接入/调优是实际工作 | 模块定位 | resume-project 面试表 |
| F3 后端名单 | 能脱口而出 6 STT / 4 LLM / 5 TTS 的名字及各自特点 | 多后端 | docs/architecture §5.3 |
| F4 启动命令 | 能报出完整启动命令（serve/local + 关键参数含义） | 落地 | 经验（对话记录） |
| F5 性能数据溯源 | 能说明 0.3s 的实测依据（TTFA 日志/测试脚本），不虚报 | 0.3s 延迟 | 经验 |
| F6 前端 demo 机制 | 能讲 demo 的 WS 客户端结构（session.update → append → 事件渲染）与后端对接 | 联调 | docs/protocol §7 |
| F7 工具链 | 能讲 uv/venv、modelscope CLI、pip extras（[paraformer] 等） | 环境 | 经验 |

---

## 三、6 周学习路线

| 周 | 主题 | 内容 | 周验收 |
|---|---|---|---|
| W1 | 语音基础 | A1-A5 | 能画四阶段流水线图；讲清 16k/24k、progressive/final |
| W2 | 大模型推理 | B1-B6 | 能对比四大 LLM 后端；能画工具调用时序 |
| W3 | 系统架构 | C1-C6 | 能画线程模型图；能完整讲打断流程与会话生命周期 |
| W4 | 网络协议 | D1-D4 | 能画双通道架构图；能报出事件表 |
| W5 | 部署实战 | E1-E5 | **动手复跑**全链路部署，记录 TTFA/RTF 实测值 |
| W6 | 项目细节+模拟 | F1-F7 + 全部 P0 | 能连续答 10 个 grilling 追问不断片 |

---

## 四、自测与演练

**画图自测**（每张能 5 分钟内默画并讲 2 分钟）：
1. 四阶段流水线数据流图（含队列）
2. 线程模型图（网络层 asyncio + 推理层线程）
3. 打断/推测性回合时序图
4. 会话生命周期图（claim→register→drain→release→quarantine）
5. 双通道架构图（WS/WebRTC + 适配器）
6. 工具调用多轮时序图

**grilling 高频题**（逐题练到能脱稿）：
1. 为什么线程+队列不是全异步？
2. 讲一次真实模型切换经历
3. 首音频延迟怎么压到 0.3s？
4. 打断时怎么保证一致性？
5. 为什么用 OpenAI Realtime 协议？
6. WebSocket 和 WebRTC 为什么都要？
7. 加一个新后端要改什么？
8. MLX 并发为什么危险？
9. 这个项目是开源的？
10. 口型同步怎么做的？

---

## 五、输出物清单

| 产物 | 内容 | 完成 |
|---|---|---|
| 6 张结构图 | 上述画图自测的 6 张图（手绘或 mermaid） | ☐ |
| 话术卡 | 身份/开源/口型/切换经历 4 段话术（背熟） | ☐ |
| 命令速查卡 | 启动命令 + 关键参数 + ModelScope 下载命令 | ☐ |
| 数据记录 | TTFA/RTF 实测值 + 模型清单（名字/大小/路径） | ☐ |
| P0 速记卡 | 6 项 P0 的"一句话结论+3 要点"（见第六部分，已产出） | ☑ |

---

## 六、P0 速记卡（必背，脱稿）

### P0-1 为什么线程+队列，不是全异步？

**一句话**：模型推理是 CPU 密集的阻塞调用，asyncio 单线程事件循环管不了它；推理放线程、网络放 asyncio、队列桥接。

**3 要点**：
1. asyncio 适合 I/O 等待（网络/文件），推理是计算密集阻塞——若放进事件循环，一个请求卡住全部并发
2. 本项目是**混合架构**：网络层（uvicorn/WebSocket 路由/send loop）用 asyncio；VAD→STT→LLM→TTS 推理链用独立线程 + `queue.Queue`；asyncio 把音频块丢进队列，send loop 从队列取音频发回
3. GIL 不是瓶颈（torch/mlx 底层 C 前向传播会释放 GIL）；真正的坑是 **MLX 单一 Metal 命令队列必须串行**（并发推理崩进程，需全局锁）

**话术**：
> "模型推理是阻塞的 CPU/GPU 密集调用，asyncio 是单线程事件循环，推理放进去会把所有并发请求卡住。所以我用的是混合架构：WebSocket 那层网络 I/O 用 asyncio（uvicorn），四段模型推理各自跑独立线程，线程之间用线程安全队列传数据，两边用队列桥接。多线程的代价主要是 MLX 有个特殊性——Metal 命令队列是单的，并发推理会崩，所以 MLX 路径要全局锁串行，实时转写用短超时抢锁、最终转写用长超时保证完成。"

### P0-2 一次真实模型切换经历

**一句话**：中文场景把 STT 从 Parakeet 切到 FunASR Paraformer，遇到设备参数、模型别名解析、推理延迟三个坑。

**3 要点**：
1. **设备参数**：Paraformer 的 device 默认 `cuda`，Apple Silicon 上必须显式传 `mps`，否则启动直接报错
2. **模型解析**：传 `paraformer-zh` 别名时 FunASR 1.4 实际解析到 **SEACO 增强版**（带说话人嵌入的变体）而不是普通版——需要确认实际加载的是哪个 repo
3. **推理延迟**：MPS 上全量推理 RTF≈55（1s 音频约 3.3s 处理），VAD 把长句切段后 final 转写比首段响应晚 2-4s，响应基于不完整转写——通过调 VAD 参数（min_speech_ms）缓解

**话术**：
> "我做过几次真实切换。最典型的是中文场景把 STT 从 Parakeet 切到 FunASR 的 Paraformer——默认的 Parakeet 覆盖 25 种欧洲语言但不擅长中文。切的时候遇到三个问题：一是设备参数默认 cuda，在 Apple Silicon 上要显式指定 mps；二是模型别名解析，传 paraformer-zh，FunASR 1.4 实际加载的是 SEACO 增强版而不是普通版，要确认清楚；三是性能，Paraformer 在 MPS 上推理 RTF 到 55，长句会切段导致响应基于不完整转写，最后靠调 VAD 参数缓解。LLM 那边也切过，llama.cpp 要 GGUF、vLLM 走远程流式，两个后端对思考开关的处理也不一样，都要实测。"

### P0-3 首音频延迟怎么压到 0.3s？

**一句话**：不等全文——句子分批 + 渐进转写复用 + TTS 合并合成 + 音频攒批发送，四件事把 TTFA 压到 0.3s 级。

**3 要点**：
1. **句子分批**：LLM 流式输出按句子攒满 3 句就下发 TTS，不用等整段响应生成完
2. **渐进转写复用**：说话过程中 progressive 转写把已确认句子固定，final 阶段只对新增音频推理再拼接——说完瞬间出完整结果，零重复计算
3. **合并与攒批**：TTS 队列内把同响应的句子块合并成一段一次合成；send loop 把音频攒满 6400B 再批量发送，减少 WebSocket 帧数

**话术**：
> "主要是不等全文。LLM 是流式的，我按句子攒满 3 句就丢给 TTS 合成，不用等整段响应。然后是渐进式转写——用户说话过程中实时转写就把已经确认的句子固定下来，语音一停，最终转写只对新增的那段音频做推理，拼上固定句子就出完整结果，不用重复算。TTS 这边把同一次响应的句子块合并成一段合成，连贯性也好。send loop 再攒批发送减少帧数。整个链路下来首音频延迟能到 0.3 秒级。"

### P0-4 打断时怎么保证一致性？

**一句话**：推测性回合 + 代数式取消 + Smart Turn 三件套——旧输出自动作废、补话自动衔接、说完判定决定宽限。

**3 要点**：
1. **推测性回合**：每个语音回合有 turn_id/revision；用户补话在宽限期内重开同一回合（revision+1），旧 revision 的所有下游输出（转写/LLM/TTS）因最新性检查失败自动丢弃
2. **代数式取消**：cancel_scope 用单调递增的 generation 代数；每次 response.create 开新代数，所有输出打代数标签，send loop 对过期代数幂等丢弃（文本和音频同规则，避免不同步）
3. **Smart Turn**：语音结束后用本地分类器判定"是否说完"——说完给短宽限（800ms），没说完给长宽限（2s）并延迟 STT/LLM 处理，给用户补话时间

**话术**：
> "核心是三个机制配合。每个语音回合有 turn_id 和 revision，用户说完话有个宽限期，期间如果补话，就重开同一回合把 revision 加一，那么旧 revision 的转写、生成、合成输出在链路里全都会被最新性检查丢掉。第二是代数式取消——每次响应开新代数，所有输出打代数标签，send loop 按标签丢弃过期输出，文本和音频用同一套规则，不会出现文本是新的音频是旧的不同步问题。第三是 Smart Turn，语音结束后用分类器判断用户是不是真说完了，说完了就短宽限快点响应，没说完就长宽限并延迟处理，给用户补话的空间。"

### P0-5 为什么选 OpenAI Realtime 协议？

**一句话**：标准协议免自研客户端、事件面齐全、前后端解耦、双通道覆盖、已有应用零改动迁移。

**3 要点**：
1. **生态标准**：官方 SDK/浏览器/移动端客户端开箱即用，不用自研协议和客户端
2. **能力完备**：音频缓冲/语音边界/实时转写/流式音频/工具调用/会话配置——实时语音需要的事件面协议全给了，自研成本高
3. **解耦+迁移**：后端专注模型管线前端复用生态；已有 OpenAI Realtime 应用可零改动切换（README 的 endpoint-swap 演示）

**话术**：
> "数字人前端要接入，标准协议是首选。第一生态标准，OpenAI 官方 SDK、浏览器、移动端都有现成客户端，我们不用自研协议和客户端。第二能力完备，实时语音要的音频缓冲、语音边界、实时转写、流式音频、工具调用、会话配置这些事件面协议全都有，自研一套代价很高。第三是解耦和迁移，后端专注模型管线，前端直接复用生态；而且已经有 OpenAI Realtime 应用的用户可以零改动切到我们服务，这个迁移红利很实在。"

### P0-6 项目身份与边界

**一句话**：数字人项目我负责语音对话模块；视觉/口型由团队其他成员负责；语音模块参考了开源方案，但选型、接入、调优是实际完成的工作。

**3 要点**：
1. **模块边界**：语音输入→活动检测→识别→生成→合成→音频+事件流，通过 OpenAI Realtime 兼容接口对接数字人前端
2. **不 claim 视觉**：被问口型同步/形象渲染，明确"团队其他成员负责，我聚焦语音模块"
3. **开源坦诚**：大方承认语音模块工程实现参考了开源方案（speech-to-speech），强调实际完成的事：模型选型、llama.cpp/vLLM 双后端接入、问题定位（RTF/多轮退化/reasoning 差异）、9 份文档

**话术**：
> "我在数字人项目里负责语音对话模块——从用户语音进来，到识别、大模型生成、合成，再到把音频和事件流给到前端，通过 OpenAI Realtime 兼容接口对接。视觉形象和口型同步是团队其他成员负责的，我聚焦语音这条链路。工程实现上我参考了开源的 speech-to-speech 方案，但我的工作是把它落地：按场景做模型选型、接入 llama.cpp 和 vLLM 两个推理后端、定位并解决了识别延迟高、小模型多轮退化这些问题，也沉淀了一套技术文档。"

---

*本文档为面试准备工具，随学习进度更新；配套 resume-project.md 与 docs/ 技术文档。*
