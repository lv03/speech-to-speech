import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(__dirname, '../../..')

export interface VoiceOptions {
  /** 项目根目录（含 gateway/ 与 src/speech_to_speech/） */
  root?: string
  /** Python 解释器路径 */
  python?: string
  /** 语音引擎 Realtime 端口 */
  port?: number
  /** 是否启用唤醒词 */
  wakeWordEnabled?: boolean
  /** 唤醒词文本 */
  wakeWord?: string
  /** Gateway URL（透传给语音引擎的工具模块） */
  gatewayUrl?: string
  /** 就绪探测超时（ms） */
  startupTimeoutMs?: number
  /** 打印 Realtime JSON 事件（供状态动画） */
  printJson?: boolean
  /** 收到一个 Realtime 事件时回调 */
  onEvent?: (event: Record<string, unknown>) => void
  /** 收到一行普通日志（启动进度/错误）时回调 */
  onLog?: (line: string) => void
  /** 是否启用声纹验证 */
  voiceprintEnabled?: boolean
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
  /** TTS 后端 */
  ttsBackend?: string
  /** TTS 音色 */
  ttsVoice?: string
}

/**
 * 内嵌启动 speech-to-speech local（语音引擎 + 麦克风/扬声器回环客户端），
 * 挂上 Agent Gateway 工具模块与（可选）唤醒词。
 */
export class EmbeddedVoice {
  private child: ChildProcess | null = null
  private ready = false
  private readonly root: string
  private readonly python: string
  private readonly port: number
  private readonly wakeWordEnabled: boolean
  private readonly wakeWord: string
  private readonly gatewayUrl: string
  private readonly startupTimeoutMs: number
  private readonly printJson: boolean
  private readonly onEvent: ((event: Record<string, unknown>) => void) | undefined
  private readonly onLog: ((line: string) => void) | undefined
  private readonly voiceprintEnabled: boolean
  private readonly llmBackend: string
  private readonly llmApiKey: string
  private readonly llmBaseUrl: string
  private readonly llmModel: string
  private readonly sttBackend: string
  private readonly sttModel: string
  private readonly ttsBackend: string
  private readonly ttsVoice: string

  constructor(options: VoiceOptions = {}) {
    this.root = options.root || process.env.GATEWAY_ROOT || DEFAULT_ROOT
    this.python = options.python || process.env.GATEWAY_PYTHON || this.findPython()
    this.port = options.port ?? Number(process.env.VOICE_PORT || 8765)
    this.wakeWordEnabled = options.wakeWordEnabled ?? false
    this.wakeWord = options.wakeWord || '噜噜噜噜'
    this.gatewayUrl = options.gatewayUrl || process.env.GATEWAY_URL || 'http://127.0.0.1:3101'
    this.startupTimeoutMs = options.startupTimeoutMs ?? 300_000
    this.printJson = options.printJson ?? true
    this.onEvent = options.onEvent
    this.onLog = options.onLog
    this.voiceprintEnabled = options.voiceprintEnabled ?? false
    this.llmBackend = options.llmBackend || 'responses-api'
    this.llmApiKey = options.llmApiKey || ''
    this.llmBaseUrl = options.llmBaseUrl || ''
    this.llmModel = options.llmModel || ''
    this.sttBackend = options.sttBackend || 'parakeet-tdt'
    this.sttModel = options.sttModel || ''
    this.ttsBackend = options.ttsBackend || 'qwen3'
    this.ttsVoice = options.ttsVoice || ''
  }

  private findPython(): string {
    const candidates = [
      `${this.root}/.venv/bin/python`,
      `${this.root}/.venv/Scripts/python.exe`,
      'python3',
      'python',
    ]
    return candidates[0] || 'python3'
  }

  get running(): boolean {
    return this.child !== null && this.ready
  }

  private buildArgs(): string[] {
    const args = [
      '-m', 'speech_to_speech.cli', 'local',
      '--tool-module', 'speech_to_speech.tools.agent_gateway',
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
      }
      if (sttModelArg[this.sttBackend]) args.push(sttModelArg[this.sttBackend], this.sttModel)
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
    if (this.llmModel) {
      args.push('--model_name', this.llmModel)
    }
    if (this.llmBaseUrl) {
      args.push('--responses_api_base_url', this.llmBaseUrl)
    }
    if (this.wakeWordEnabled) {
      args.push('--enable_wake_word', '--wake_word', this.wakeWord)
    }
    if (this.voiceprintEnabled) {
      args.push('--enable_voiceprint')
    }
    if (this.printJson) {
      args.push('--local_audio_print_json')
    }
    return args
  }

  /** 行缓冲，从 stdout 解析 EVENT 行给 onEvent，其余行给 onLog。 */
  private parseStdout(chunk: Buffer): void {
    for (const line of chunk.toString('utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('EVENT: ')) {
        try {
          const event = JSON.parse(trimmed.slice('EVENT: '.length))
          this.onEvent?.(event as Record<string, unknown>)
        } catch {
          // 非 JSON 行忽略
        }
      } else {
        this.onLog?.(trimmed)
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // 语音引擎的工具模块据此定位 Gateway
      GATEWAY_URL: this.gatewayUrl,
    }
    if (this.llmApiKey) {
      env.OPENAI_API_KEY = this.llmApiKey
    }

    this.child = spawn(this.python, this.buildArgs(), {
      cwd: this.root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.child.stdout?.on('data', (chunk) => {
      this.parseStdout(chunk)
      process.stdout.write(`[voice] ${chunk}`)
    })
    this.child.stderr?.on('data', (chunk) => {
      process.stderr.write(`[voice] ${chunk}`)
      for (const line of chunk.toString('utf-8').split('\n')) {
        const trimmed = line.trim()
        if (trimmed) this.onLog?.(trimmed)
      }
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
      const READY_MARKERS = [
        'Application startup complete',
        'Uvicorn running',
        'Connected.',
        'session.created',
      ]
      const check = (chunk: Buffer) => {
        const text = chunk.toString()
        if (READY_MARKERS.some((marker) => text.includes(marker))) {
          clearTimeout(timer)
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

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.ready = false
    if (!child) return
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
