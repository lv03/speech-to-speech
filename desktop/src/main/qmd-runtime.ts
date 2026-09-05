import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface QmdEndpoint {
  baseUrl: string
  port: number
}

export interface QmdChildProcess {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout?: { on(event: string, listener: (chunk: Buffer) => void): unknown } | null
  stderr?: { on(event: string, listener: (chunk: Buffer) => void): unknown } | null
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type QmdProcessSpawner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => QmdChildProcess

export interface QmdRuntimeOptions {
  resourceRoot: string
  dataRoot: string
  portProvider?: () => Promise<number>
  spawnProcess?: QmdProcessSpawner
  fetch?: typeof fetch
  probe?: (baseUrl: string, fetchImpl: typeof fetch) => Promise<boolean>
  startupTimeoutMs?: number
}

const MCP_PROTOCOL_VERSION = '2025-06-18'

function spawnProcess(command: string, args: string[], options: Parameters<QmdProcessSpawner>[2]): ChildProcess {
  return spawn(command, args, options)
}

async function findFreePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '::1', () => resolvePromise())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  if (!port) throw new Error('Unable to allocate a loopback port for QMD')
  return port
}

async function defaultProbe(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'speech-to-speech-health',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'speech-to-speech', version: '0.1.0' },
        },
      }),
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return false
    const body = typeof response.text === 'function' ? await response.text() : ''
    const dataLine = body
      .split(/\r?\n/)
      .find((line) => line.startsWith('data:'))
      ?.slice('data:'.length)
      .trim()
    const payload = JSON.parse(dataLine || body) as {
      result?: { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } }
      error?: unknown
    }
    return (
      typeof payload.result?.protocolVersion === 'string' &&
      payload.result.serverInfo?.name === 'qmd' &&
      typeof payload.result.serverInfo.version === 'string' &&
      !payload.error
    )
  } catch {
    return false
  }
}

function qmdEntrypoint(resourceRoot: string): string {
  return join(resourceRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd')
}

export class QmdRuntime {
  private readonly resourceRoot: string
  private readonly dataRoot: string
  private readonly portProvider: () => Promise<number>
  private readonly spawnProcess: QmdProcessSpawner
  private readonly fetchImpl: typeof fetch
  private readonly probe: (baseUrl: string, fetchImpl: typeof fetch) => Promise<boolean>
  private readonly startupTimeoutMs: number
  private child: QmdChildProcess | null = null
  private endpoint: QmdEndpoint | null = null

  constructor(options: QmdRuntimeOptions) {
    this.resourceRoot = options.resourceRoot
    this.dataRoot = options.dataRoot
    this.portProvider = options.portProvider ?? findFreePort
    this.spawnProcess = options.spawnProcess ?? spawnProcess
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.probe = options.probe ?? defaultProbe
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000
  }

  private async environment(): Promise<NodeJS.ProcessEnv> {
    const qmdRoot = join(this.dataRoot, 'qmd')
    const home = join(qmdRoot, 'home')
    const config = join(qmdRoot, 'config')
    const cache = join(qmdRoot, 'cache')
    const configDir = join(config, 'qmd')
    const indexPath = join(cache, 'qmd', 'index.sqlite')
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(config, { recursive: true }),
      mkdir(configDir, { recursive: true }),
      mkdir(dirname(indexPath), { recursive: true }),
    ])
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOME: home,
      XDG_CONFIG_HOME: config,
      QMD_CONFIG_DIR: configDir,
      XDG_CACHE_HOME: cache,
      INDEX_PATH: indexPath,
      QMD_INDEX_PATH: indexPath,
    }
  }

  async start(): Promise<QmdEndpoint> {
    if (this.child && this.endpoint) return this.endpoint

    const port = await this.portProvider()
    const entrypoint = qmdEntrypoint(this.resourceRoot)
    const child = this.spawnProcess(
      process.execPath,
      [entrypoint, 'mcp', '--http', '--host', '::1', '--port', String(port)],
      { cwd: this.resourceRoot, env: await this.environment(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    this.child = child
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', () => undefined)
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null
        this.endpoint = null
      }
    })

    try {
      if (child.exitCode !== null) throw new Error(`QMD process exited before probe (code=${child.exitCode})`)
      const endpoint = { baseUrl: `http://[::1]:${port}/mcp`, port }
      const deadline = Date.now() + this.startupTimeoutMs
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`QMD process exited before probe (code=${child.exitCode})`)
        if (await this.probe(endpoint.baseUrl, this.fetchImpl)) {
          this.endpoint = endpoint
          return endpoint
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
      throw new Error('QMD initialize probe timed out')
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async health(): Promise<boolean> {
    if (!this.child || !this.endpoint || this.child.exitCode !== null) return false
    return this.probe(this.endpoint.baseUrl, this.fetchImpl)
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.endpoint = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolvePromise) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise()
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, 3000)
      child.once('exit', finish)
      child.kill()
      if (child.exitCode !== null || child.signalCode !== null) finish()
    })
  }
}
