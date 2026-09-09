import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findPython } from './gateway-process'
import type { RuntimePaths } from './runtime-types'
import { getSttHotwordFlag, normalizeSttHotwords } from '../shared/stt-hotwords.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(__dirname, '../../..')

export interface VoiceOptions {
  /** 项目根目录（含 gateway/ 与 src/speech_to_speech/） */
  root?: string
  /** Python 解释器路径 */
  python?: string
  /** Authoritative PythonRuntime result for packaged launches. */
  runtime?: RuntimePaths
  /** Packaged mode refuses local/PATH probing unless runtime is supplied. */
  mode?: 'development' | 'packaged'
  /** 语音引擎 Realtime 端口 */
  port?: number
  /** 是否启用唤醒词 */
  wakeWordEnabled?: boolean
  /** 唤醒词文本 */
  wakeWord?: string
  /** 唤醒词静默后重新上锁的秒数 */
  securityTimeoutS?: number
  /** Gateway URL（透传给语音引擎的工具模块） */
  gatewayUrl?: string
  /** Knowledge proxy loopback URL（只通过子进程环境注入） */
  qmdProxyUrl?: string
  /** Knowledge proxy bearer token（只通过子进程环境注入） */
  qmdProxyToken?: string
  /** 就绪探测超时（ms） */
  startupTimeoutMs?: number
  /** 打印 Realtime JSON 事件（供状态动画） */
  printJson?: boolean
  /** 收到一个 Realtime 事件时回调 */
  onEvent?: (event: Record<string, unknown>) => void
  /** 唤醒词安全门锁定/解锁状态回调（true=锁定） */
  onSecurityState?: (locked: boolean) => void
  /** 收到一行普通日志（启动进度/错误）时回调 */
  onLog?: (line: string) => void
  /** 是否启用声纹验证 */
  voiceprintEnabled?: boolean
  /** 声纹验证阈值（0,1] */
  voiceprintThreshold?: number
  /** LLM 后端 */
  llmBackend?: string
  /** LLM API Key */
  llmApiKey?: string
  /** LLM API 地址（--responses_api_base_url） */
  llmBaseUrl?: string
  /** LLM 模型名 */
  llmModel?: string
  /** STT 后端 */
  sttBackend?: string
  /** STT 模型名 */
  sttModel?: string
  /** STT 热词（空格分隔） */
  sttHotwords?: string
  /** TTS 后端 */
  ttsBackend?: string
  /** TTS 音色 */
  ttsVoice?: string
  /** LLM 推理等级（none/low/medium/high，仅 responses-api / chat-completions 后端生效） */
  llmReasoningEffort?: 'none' | 'low' | 'medium' | 'high'
  /** 长期记忆开关（默认关闭） */
  memoryEnabled?: boolean
  /** 允许云端事实抽取（记忆写入的必要条件） */
  memoryCloudConsent?: boolean
  /** 装有 voicemem 的解释器路径 */
  memorySidecarPython?: string
  /** 记忆 sidecar 入口脚本路径 */
  memorySidecarScript?: string
  /** app-private 记忆目录 */
  memoryRoot?: string
  /** 事实抽取端点（启用记忆时必填） */
  memoryExtractionBaseUrl?: string
  /** 事实抽取模型 */
  memoryExtractionModel?: string
  /** QMD 守护进程的 /embed 基础地址（记忆嵌入来源） */
  memoryEmbedderBaseUrl?: string
  /** 单次响应注入的记忆块最大字符数 */
  memoryMaxChars?: number
}

export interface VoiceEnvironmentOptions {
  baseEnv?: NodeJS.ProcessEnv
  gatewayUrl: string
  qmdProxyUrl?: string
  qmdProxyToken?: string
  llmApiKey?: string
  memoryEnabled?: boolean
  memoryCloudConsent?: boolean
  memorySidecarPython?: string
  memorySidecarScript?: string
  memoryRoot?: string
  memoryExtractionBaseUrl?: string
  memoryExtractionModel?: string
  memoryEmbedderBaseUrl?: string
  memoryMaxChars?: number
}

/** Build the child-only environment without putting knowledge credentials in argv. */
export function buildVoiceEnvironment(options: VoiceEnvironmentOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) }
  env.GATEWAY_URL = options.gatewayUrl
  delete env.QMD_PROXY_URL
  delete env.QMD_PROXY_TOKEN
  if (options.qmdProxyUrl && options.qmdProxyToken) {
    env.QMD_PROXY_URL = options.qmdProxyUrl
    env.QMD_PROXY_TOKEN = options.qmdProxyToken
  }
  if (options.llmApiKey) env.OPENAI_API_KEY = options.llmApiKey
  // Memory paths travel through the environment, never argv: they would
  // otherwise show up in process listings and voice logs.
  for (const key of [
    'S2S_MEMORY_BACKEND',
    'S2S_MEMORY_SIDECAR_PYTHON',
    'S2S_MEMORY_SIDECAR_SCRIPT',
    'S2S_MEMORY_ROOT',
    'S2S_MEMORY_BASE_URL',
    'S2S_MEMORY_MODEL',
    'S2S_MEMORY_EMBEDDER',
    'S2S_MEMORY_EMBEDDER_BASE_URL',
    'S2S_MEMORY_VECTOR_STORE',
    'S2S_MEMORY_MAX_CHARS',
  ]) {
    delete env[key]
  }
  if (options.memoryEnabled && options.memoryCloudConsent) {
    env.S2S_MEMORY_BACKEND = 'voicemem'
    if (options.memorySidecarPython) env.S2S_MEMORY_SIDECAR_PYTHON = options.memorySidecarPython
    if (options.memorySidecarScript) env.S2S_MEMORY_SIDECAR_SCRIPT = options.memorySidecarScript
    if (options.memoryRoot) env.S2S_MEMORY_ROOT = options.memoryRoot
    if (options.memoryExtractionBaseUrl) env.S2S_MEMORY_BASE_URL = options.memoryExtractionBaseUrl
    if (options.memoryExtractionModel) env.S2S_MEMORY_MODEL = options.memoryExtractionModel
    // Embeddings always come from the QMD daemon; when it is unavailable the
    // base URL is absent and the sidecar fails closed instead of loading another
    // model. The backend name is always set so there is no silent fallback.
    env.S2S_MEMORY_EMBEDDER = 'qmd'
    if (options.memoryEmbedderBaseUrl) env.S2S_MEMORY_EMBEDDER_BASE_URL = options.memoryEmbedderBaseUrl
    // Pinned, not a user setting: mem0 stores vectors in SQLite via sqlite-vec.
    // Rolling back to mem0's embedded Qdrant means editing this constant (or
    // running the sidecar by hand with S2S_MEMORY_VECTOR_STORE=qdrant).
    env.S2S_MEMORY_VECTOR_STORE = 'sqlite_vec'
    if (options.memoryMaxChars) env.S2S_MEMORY_MAX_CHARS = String(options.memoryMaxChars)
  }
  return env
}

/**
 * 内嵌启动 speech-to-speech local（语音引擎 + 麦克风/扬声器回环客户端），
 * 挂上 Agent Gateway 工具模块与（可选）唤醒词。
 */
export class EmbeddedVoice {
  private child: ChildProcess | null = null
  private ready = false
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private readonly root: string
  private readonly python: string
  private readonly port: number
  private readonly wakeWordEnabled: boolean
  private readonly wakeWord: string
  private readonly securityTimeoutS: number
  private readonly gatewayUrl: string
  private readonly qmdProxyUrl: string
  private readonly qmdProxyToken: string
  private readonly memoryEnabled: boolean
  private readonly memoryCloudConsent: boolean
  private readonly memorySidecarPython: string
  private readonly memorySidecarScript: string
  private readonly memoryRoot: string
  private readonly memoryExtractionBaseUrl: string
  private readonly memoryExtractionModel: string
  private readonly memoryEmbedderBaseUrl: string
  private readonly memoryMaxChars: number
  private readonly startupTimeoutMs: number
  private readonly printJson: boolean
  private readonly onEvent: ((event: Record<string, unknown>) => void) | undefined
  private readonly onSecurityState: ((locked: boolean) => void) | undefined
  private readonly onLog: ((line: string) => void) | undefined
  private readonly voiceprintEnabled: boolean
  private readonly voiceprintThreshold: number
  private readonly llmBackend: string
  private readonly llmApiKey: string
  private readonly llmBaseUrl: string
  private readonly llmModel: string
  private readonly sttBackend: string
  private readonly sttModel: string
  private readonly sttHotwords: string
  private readonly ttsBackend: string
  private readonly ttsVoice: string
  private readonly llmReasoningEffort: 'none' | 'low' | 'medium' | 'high'

  constructor(options: VoiceOptions = {}) {
    if (options.mode === 'packaged' && !options.runtime) {
      throw new Error('Packaged Voice requires PythonRuntime paths')
    }
    this.root = options.runtime?.appRoot || options.root || process.env.GATEWAY_ROOT || DEFAULT_ROOT
    this.python = options.runtime?.python || options.python || findPython(this.root)
    this.port = options.port ?? Number(process.env.VOICE_PORT || 8765)
    this.wakeWordEnabled = options.wakeWordEnabled ?? false
    this.wakeWord = options.wakeWord || '你好，噜噜'
    this.securityTimeoutS = Math.max(0, options.securityTimeoutS ?? 60)
    this.gatewayUrl = options.gatewayUrl || process.env.GATEWAY_URL || 'http://127.0.0.1:3101'
    this.qmdProxyUrl = options.qmdProxyUrl || ''
    this.qmdProxyToken = options.qmdProxyToken || ''
    this.memoryEnabled = options.memoryEnabled === true
    this.memoryCloudConsent = options.memoryCloudConsent === true
    this.memorySidecarPython = options.memorySidecarPython || ''
    this.memorySidecarScript = options.memorySidecarScript || ''
    this.memoryRoot = options.memoryRoot || ''
    this.memoryExtractionBaseUrl = options.memoryExtractionBaseUrl || ''
    this.memoryExtractionModel = options.memoryExtractionModel || ''
    this.memoryEmbedderBaseUrl = options.memoryEmbedderBaseUrl || ''
    this.memoryMaxChars = Number(options.memoryMaxChars) || 1200
    this.startupTimeoutMs = options.startupTimeoutMs ?? 300_000
    this.printJson = options.printJson ?? true
    this.onEvent = options.onEvent
    this.onSecurityState = options.onSecurityState
    this.onLog = options.onLog
    this.voiceprintEnabled = options.voiceprintEnabled ?? false
    this.voiceprintThreshold = options.voiceprintThreshold ?? 0.75
    this.llmBackend = options.llmBackend || 'responses-api'
    this.llmApiKey = options.llmApiKey || ''
    this.llmBaseUrl = options.llmBaseUrl || ''
    this.llmModel = options.llmModel || ''
    this.sttBackend = options.sttBackend || 'parakeet-tdt'
    this.sttModel = options.sttModel || ''
    this.sttHotwords = normalizeSttHotwords(options.sttHotwords || '')
    this.ttsBackend = options.ttsBackend || 'qwen3'
    this.ttsVoice = options.ttsVoice || ''
    this.llmReasoningEffort = options.llmReasoningEffort ?? 'none'
  }

  get running(): boolean {
    return this.child !== null && this.ready
  }

  private buildArgs(): string[] {
    const args = [
      '-m', 'speech_to_speech.cli', 'local',
      '--tool-module', 'speech_to_speech.tools.agent_gateway,speech_to_speech.tools.qmd_knowledge',
      '--port', String(this.port),
      '--stt', this.sttBackend,
      '--tts', this.ttsBackend,
      '--llm_backend', this.llmBackend,
    ]
    // STT 模型（参数名随后端而异）
    if (this.sttModel) {
      const sttModelArg: Record<string, string> = {
        'parakeet-tdt': '--parakeet_tdt_model_name',
        'whisper': '--stt_model_name',
        'faster-whisper': '--faster_whisper_stt_model_name',
        'paraformer': '--paraformer_stt_model_name',
        'fun-asr-nano': '--fun_asr_nano_stt_model_name',
      }
      if (sttModelArg[this.sttBackend]) args.push(sttModelArg[this.sttBackend], this.sttModel)
    }
    const hotwordFlag = getSttHotwordFlag(this.sttBackend)
    if (hotwordFlag && this.sttHotwords) {
      args.push(hotwordFlag, this.sttHotwords)
    }
    // TTS 音色（参数名随后端而异）
    if (this.ttsVoice) {
      const ttsVoiceArg: Record<string, string> = {
        'qwen3': '--qwen3_tts_speaker',
        'kokoro': '--kokoro_voice',
        'pocket': '--pocket_tts_voice',
      }
      if (ttsVoiceArg[this.ttsBackend]) args.push(ttsVoiceArg[this.ttsBackend], this.ttsVoice)
    }
    // VAD 投机重开调参（实验）：拉长提交窗口、收紧未回复重开窗口，
    // 避免「短句+停顿+继续补充」的说话方式触发过频 revision 重开。
    args.push('--speculative_reopen_ms', '2500', '--unanswered_reopen_ms', '1500')
    if (this.llmModel) {
      args.push('--model_name', this.llmModel)
    }
    if (this.llmBaseUrl) {
      args.push('--responses_api_base_url', this.llmBaseUrl)
    }
    // 远程 LLM 推理等级：none = 关闭思考（走 --responses_api_disable_thinking，
    // vLLM/Qwen 经 chat_template_kwargs.enable_thinking=false 生效；responses-api
    // 后端由 reasoning_effort 默认值 "none" 短路为原生 reasoning.effort=none）；
    // low/medium/high = 思考强度（--responses_api_reasoning_effort）。
    if (this.llmBackend === 'responses-api' || this.llmBackend === 'chat-completions') {
      const effort = this.llmReasoningEffort ?? 'none'
      if (effort === 'none') {
        args.push('--responses_api_disable_thinking')
      } else {
        args.push('--responses_api_reasoning_effort', effort)
      }
    }
    if (this.wakeWordEnabled) {
      args.push('--enable_wake_word', '--wake_word', this.wakeWord)
      args.push('--security_timeout_s', String(this.securityTimeoutS))
    }
    if (this.voiceprintEnabled) {
      args.push('--enable_voiceprint')
      args.push('--voiceprint_threshold', String(this.voiceprintThreshold))
    }
    if (this.printJson) {
      args.push('--local_audio_print_json')
    }
    return args
  }

  /** 行缓冲，从 stdout 解析 EVENT 行给 onEvent，其余行给 onLog。
   *  跨 chunk 断行时保留残尾到下一块拼接，避免事件/日志被拆丢。 */
  private parseStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf-8')
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('EVENT: ')) {
        try {
          const event = JSON.parse(trimmed.slice('EVENT: '.length)) as Record<string, unknown>
          const eventType = String(event.type ?? '')
          if (eventType === 'security.locked' || eventType === 'security.unlocked') {
            this.onSecurityState?.(eventType === 'security.locked')
          } else {
            this.onEvent?.(event)
          }
        } catch {
          // 非 JSON 行忽略
        }
      } else {
        this.onLog?.(trimmed)
      }
    }
  }

  /** stderr 行缓冲：按 \n 拆行并保留残尾。 */
  private parseStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf-8')
    const lines = this.stderrBuffer.split('\n')
    this.stderrBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) this.onLog?.(trimmed)
    }
  }

  async start(): Promise<void> {
    if (this.running) return

    const env = buildVoiceEnvironment({
      gatewayUrl: this.gatewayUrl,
      qmdProxyUrl: this.qmdProxyUrl,
      qmdProxyToken: this.qmdProxyToken,
      memoryEnabled: this.memoryEnabled,
      memoryCloudConsent: this.memoryCloudConsent,
      memorySidecarPython: this.memorySidecarPython,
      memorySidecarScript: this.memorySidecarScript,
      memoryRoot: this.memoryRoot,
      memoryExtractionBaseUrl: this.memoryExtractionBaseUrl,
      memoryExtractionModel: this.memoryExtractionModel,
      memoryEmbedderBaseUrl: this.memoryEmbedderBaseUrl,
      memoryMaxChars: this.memoryMaxChars,
      llmApiKey: this.llmApiKey,
    })

    this.child = spawn(this.python, this.buildArgs(), {
      cwd: this.root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout?.on('data', (chunk) => {
      this.parseStdout(chunk)
      process.stdout.write(`[voice] ${chunk}`)
    })
    this.child.stderr?.on('data', (chunk) => {
      process.stderr.write(`[voice] ${chunk}`)
      this.parseStderr(chunk)
    })
    this.child.once('exit', (code, signal) => {
      this.child = null
      this.ready = false
      if (code !== 0 && code !== null) {
        process.stderr.write(`[voice] exited unexpectedly code=${code} signal=${signal ?? ''}\n`)
      }
    })

    // 就绪探测：等待 server 打印启动完成
    await this.waitUntilReady()
  }

  private waitUntilReady(): Promise<void> {
    const child = this.child
    if (!child) return Promise.reject(new Error('语音引擎未启动'))
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error('语音引擎启动超时'))
      }, this.startupTimeoutMs)
      // local 模式不跑 uvicorn 启动日志；真正的就绪信号是回环客户端
      // 连上服务后打印的 "Connected."（以及 session.created 事件）。
      // 用独立缓冲拼接所有 stdout/stderr，避免就绪标记被 chunk 拆断。
      const READY_MARKERS = [
        'Application startup complete',
        'Uvicorn running',
        'Connected.',
        'session.created',
      ]
      let readyText = ''
      const check = (chunk: Buffer) => {
        readyText += chunk.toString()
        if (READY_MARKERS.some((marker) => readyText.includes(marker))) {
          clearTimeout(timer)
          child.stdout?.removeListener('data', check)
          child.stderr?.removeListener('data', check)
          this.ready = true
          resolvePromise()
        }
      }
      // uvicorn 的启动日志在 stderr，必须同时监听两个流
      child.stdout?.on('data', check)
      child.stderr?.on('data', check)
      child.once('exit', (code) => {
        clearTimeout(timer)
        rejectPromise(new Error(`语音引擎提前退出（${code ?? 'unknown'}）`))
      })
    })
  }

  /** 播报一句文本（复用语音引擎已加载的 TTS 模型，不再另起 announcer 进程）。 */
  speak(text: string): void {
    if (!this.ready || !this.child?.stdin) return
    this.child.stdin.write(JSON.stringify({ type: 'speak', text }) + '\n')
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.ready = false
    if (!child) return
    // 进程已退出时无需等待：once('exit') 在事件已发生后注册不会触发，
    // 否则会白等 5s 再 SIGKILL（app 退出会被拖慢）。
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolvePromise()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
    })
  }
}
