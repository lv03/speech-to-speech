import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const INCLUDE_PATTERN = '**/*.md'
const COLLECTION_NAME = /^kb_col_[a-f0-9]{32}$/

export interface QmdIndexChildProcess {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type QmdIndexProcessSpawner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'ignore' },
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
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(config, { recursive: true, mode: 0o700 }),
      mkdir(configDir, { recursive: true, mode: 0o700 }),
      mkdir(dirname(indexPath), { recursive: true, mode: 0o700 }),
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

  private async run(args: string[]): Promise<void> {
    const child = this.spawnProcess(process.execPath, [this.entrypoint(), ...args], {
      cwd: this.resourceRoot,
      env: await this.environment(),
      stdio: 'ignore',
    })
    const exitCode = await new Promise<number | null>((resolveExit) => {
      if (child.exitCode !== null) {
        resolveExit(child.exitCode)
        return
      }
      child.once('exit', (code) => resolveExit(code))
    })
    if (exitCode !== 0) throw new Error('QMD index operation failed')
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

  async reindex(internalName: string): Promise<void> {
    assertCollectionName(internalName)
    await this.run(['update'])
    await this.run(['embed', '--force'])
  }

  async deleteIndex(internalName: string): Promise<void> {
    await this.remove(internalName)
  }
}
