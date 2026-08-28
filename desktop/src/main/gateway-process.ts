import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 项目根目录：desktop/out/main → ../../.. 是仓库根（含 gateway/ 包）
const DEFAULT_ROOT = resolve(__dirname, '../../..')

export interface GatewayOptions {
  /** 项目根目录（含 gateway/ Python 包） */
  root?: string
  /** Python 解释器路径（默认自动探测） */
  python?: string
  /** Gateway 端口 */
  port?: number
  /** 就绪探测超时（ms） */
  startupTimeoutMs?: number
}

/**
 * 探测可用的 Python 解释器：
 * 1. GATEWAY_PYTHON 环境变量
 * 2. 项目根目录 .venv/bin/python（或 Windows Scripts/python.exe）
 * 3. PATH 上的 python3 / python
 */
export function findPython(root: string): string {
  const explicit = process.env.GATEWAY_PYTHON
  if (explicit && existsSync(explicit)) return explicit

  const candidates = [
    join(root, '.venv', 'bin', 'python'),
    join(root, '.venv', 'Scripts', 'python.exe'),
    'python3',
    'python',
  ]
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
    }
  }
  return 'python3'
}

export class EmbeddedGateway {
  private child: ChildProcess | null = null
  private origin: string | null = null
  private readonly root: string
  private readonly python: string
  private readonly port: number
  private readonly startupTimeoutMs: number

  constructor(options: GatewayOptions = {}) {
    this.root = options.root || process.env.GATEWAY_ROOT || DEFAULT_ROOT
    this.python = options.python || findPython(this.root)
    this.port = options.port ?? Number(process.env.GATEWAY_PORT || 3101)
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000
  }

  get running(): boolean {
    return this.child !== null && this.origin !== null
  }

  get url(): string | null {
    return this.origin
  }

  async health(): Promise<Record<string, unknown> | null> {
    const base = this.origin ?? `http://127.0.0.1:${this.port}`
    try {
      const resp = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!resp.ok) return null
      return (await resp.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  /** 启动 gateway 子进程并等待就绪。 */
  async start(): Promise<string> {
    if (this.running) return this.origin!

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(this.port),
    }

    this.child = spawn(this.python, ['-m', 'gateway'], {
      cwd: this.root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.child.stdout?.on('data', (chunk) => {
      process.stdout.write(`[gateway] ${chunk}`)
    })
    this.child.stderr?.on('data', (chunk) => {
      process.stderr.write(`[gateway] ${chunk}`)
    })
    this.child.once('exit', (code, signal) => {
      if (this.child) {
        this.child = null
        this.origin = null
      }
      if (code !== 0 && code !== null) {
        process.stderr.write(`[gateway] exited unexpectedly code=${code} signal=${signal ?? ''}\n`)
      }
    })

    const base = `http://127.0.0.1:${this.port}`
    const deadline = Date.now() + this.startupTimeoutMs
    while (Date.now() < deadline) {
      // 子进程已退出（如端口被占用）时立即失败，不要继续轮询——
      // 否则可能命中端口上其他服务的 /health，误判为就绪。
      if (this.child && this.child.exitCode !== null) {
        throw new Error(`Gateway 进程提前退出（code=${this.child.exitCode}）`)
      }
      if (await this.health()) {
        this.origin = base
        return base
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error('Gateway 启动超时')
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.origin = null
    if (!child) return
    // 进程已退出时直接返回，避免 once('exit') 永不触发而白等 3s
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolvePromise()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
    })
  }
}
