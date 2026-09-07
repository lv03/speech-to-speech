import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, open, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const INCLUDE_PATTERN = '**/*.md'
const COLLECTION_NAME = /^kb_col_[a-f0-9]{32}$/

export interface QmdIndexChildProcess {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type QmdIndexProcessSpawner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => QmdIndexChildProcess

export interface QmdIndexerOptions {
  resourceRoot: string
  dataRoot: string
  spawnProcess?: QmdIndexProcessSpawner
}

function spawnProcess(command: string, args: string[], options: Parameters<QmdIndexProcessSpawner>[2]): ChildProcess {
  return spawn(command, args, options)
}

function assertCollectionName(name: string): void {
  if (!COLLECTION_NAME.test(name)) throw new Error('Invalid QMD collection name')
}

export class QmdCollectionMissingError extends Error {
  constructor() {
    super('QMD collection is missing')
    this.name = 'QmdCollectionMissingError'
  }
}

export class QmdIndexer {
  private readonly resourceRoot: string
  private readonly dataRoot: string
  private readonly spawnProcess: QmdIndexProcessSpawner

  constructor(options: QmdIndexerOptions) {
    this.resourceRoot = resolve(options.resourceRoot)
    this.dataRoot = resolve(options.dataRoot)
    this.spawnProcess = options.spawnProcess ?? spawnProcess
  }

  private entrypoint(): string {
    return join(this.resourceRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd')
  }

  private async environment(): Promise<NodeJS.ProcessEnv> {
    const qmdRoot = join(this.dataRoot, 'qmd')
    const home = join(qmdRoot, 'home')
    const config = join(qmdRoot, 'config')
    const cache = join(qmdRoot, 'cache')
    const configDir = join(config, 'qmd')
    const indexPath = join(cache, 'qmd', 'index.sqlite')
    await Promise.all([qmdRoot, home, config, configDir, cache, dirname(indexPath)].map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
    }))
    const index = await open(indexPath, 'a', 0o600)
    try {
      await chmod(indexPath, 0o600)
    } finally {
      await index.close()
    }
    const configPath = join(configDir, 'index.yml')
    try {
      await stat(configPath)
      await chmod(configPath, 0o600)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') throw error
    }
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

  private async run(args: string[]): Promise<void> {
    let output = ''
    const child = this.spawnProcess(process.execPath, [this.entrypoint(), ...args], {
      cwd: this.resourceRoot,
      env: await this.environment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const capture = (chunk: Buffer) => {
      if (output.length < 8192) output += chunk.toString('utf8').slice(0, 8192 - output.length)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    const result = await new Promise<{ exitCode: number | null } | { error: Error }>((resolveProcess) => {
      let settled = false
      const settle = (result: { exitCode: number | null } | { error: Error }) => {
        if (settled) return
        settled = true
        resolveProcess(result)
      }
      if (child.exitCode !== null) {
        settle({ exitCode: child.exitCode })
        return
      }
      child.once('error', (error) => settle({ error }))
      child.once('exit', (code) => settle({ exitCode: code }))
    })
    if ('error' in result) throw new Error('QMD index operation failed')
    const exitCode = result.exitCode
    if (exitCode !== 0) {
      if (/collection\s+not\s+found/i.test(output)) throw new QmdCollectionMissingError()
      throw new Error('QMD index operation failed')
    }
  }

  async add(internalName: string, root: string, include: string): Promise<void> {
    assertCollectionName(internalName)
    if (include !== INCLUDE_PATTERN) throw new Error('Invalid QMD collection mask')
    const canonicalRoot = await realpath(root)
    await this.run(['collection', 'add', canonicalRoot, '--name', internalName, '--mask', INCLUDE_PATTERN])
  }

  async remove(internalName: string): Promise<void> {
    assertCollectionName(internalName)
    await this.run(['collection', 'remove', internalName])
  }

  async embed(): Promise<void> {
    await this.run(['embed'])
  }

  async reindex(internalName: string, root?: string, include = INCLUDE_PATTERN): Promise<void> {
    assertCollectionName(internalName)
    try {
      await this.run(['update'])
      await this.run(['embed', '--force'])
    } catch (error) {
      if (!(error instanceof QmdCollectionMissingError) || !root) throw error
      await this.add(internalName, root, include)
      await this.run(['update'])
      await this.run(['embed', '--force'])
    }
  }

  async deleteIndex(internalName: string): Promise<void> {
    await this.remove(internalName)
  }
}
