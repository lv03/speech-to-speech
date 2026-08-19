import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findPython } from './gateway-process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(__dirname, '../../..')

export interface AnnouncerOptions {
  /** 项目根目录（含 src/speech_to_speech/） */
  root?: string
  /** Python 解释器路径 */
  python?: string
  /** Qwen3-TTS CustomVoice 模型 */
  model?: string
  /** CustomVoice 音色 */
  speaker?: string
  /** 合成语言 */
  language?: string
  /** 就绪探测超时（ms，模型加载较慢） */
  startupTimeoutMs?: number
  /** 普通日志回调 */
  onLog?: (line: string) => void
}

/**
 * 内嵌启动 speech-to-speech announcer（Qwen3-TTS 语音播报守护进程）。
 * 常驻加载一次模型，通过 stdin JSONL 接收播报请求。
 */
export class EmbeddedAnnouncer {
  private child: ChildProcess | null = null
  private ready = false
  private readonly root: string
  private readonly python: string
  private readonly model: string
  private readonly speaker: string
  private readonly language: string
  private readonly startupTimeoutMs: number
  private readonly onLog: ((line: string) => void) | undefined

  constructor(options: AnnouncerOptions = {}) {
    this.root = options.root || process.env.GATEWAY_ROOT || DEFAULT_ROOT
    this.python = options.python || findPython(this.root)
    this.model = options.model || ''
    this.speaker = options.speaker || ''
    this.language = options.language || 'chinese'
    this.startupTimeoutMs = options.startupTimeoutMs ?? 180_000
    this.onLog = options.onLog
  }

  get running(): boolean {
    return this.child !== null && this.ready
  }

  private buildArgs(): string[] {
    const args = ['-m', 'speech_to_speech.announcer', '--language', this.language]
    if (this.model) args.push('--model', this.model)
    if (this.speaker) args.push('--speaker', this.speaker)
    return args
  }

  async start(): Promise<void> {
    if (this.running) return

    this.child = spawn(this.python, this.buildArgs(), {
      cwd: this.root,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout?.on('data', (chunk) => {
      process.stdout.write(`[announcer] ${chunk}`)
    })
    this.child.stderr?.on('data', (chunk) => {
      process.stderr.write(`[announcer] ${chunk}`)
      for (const line of chunk.toString('utf-8').split('\n')) {
        const trimmed = line.trim()
        if (trimmed) this.onLog?.(trimmed)
      }
    })
    this.child.once('exit', (code, signal) => {
      this.child = null
      this.ready = false
      if (code !== 0 && code !== null) {
        process.stderr.write(`[announcer] exited unexpectedly code=${code} signal=${signal ?? ''}\n`)
      }
    })

    await this.waitUntilReady()
  }

  private waitUntilReady(): Promise<void> {
    const child = this.child
    if (!child) return Promise.reject(new Error('announcer 未启动'))
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error('announcer 启动超时'))
      }, this.startupTimeoutMs)
      const check = (chunk: Buffer) => {
        if (chunk.toString().includes('"type":"ready"') || chunk.toString().includes('"type": "ready"')) {
          clearTimeout(timer)
          this.ready = true
          resolvePromise()
        }
      }
      child.stdout?.on('data', check)
      child.once('exit', (code) => {
        clearTimeout(timer)
        rejectPromise(new Error(`announcer 提前退出（${code ?? 'unknown'}）`))
      })
    })
  }

  /** 播报一句文本（进程未就绪时静默忽略）。 */
  speak(text: string): void {
    if (!this.ready || !this.child?.stdin) return
    this.child.stdin.write(JSON.stringify({ type: 'speak', text }) + '\n')
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.ready = false
    if (!child) return
    try {
      child.stdin?.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      child.stdin?.end()
    } catch {
      // stdin 可能已关闭
    }
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
