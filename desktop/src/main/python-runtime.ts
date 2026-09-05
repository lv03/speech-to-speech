import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

import type { RuntimeAsset, RuntimeManifest, RuntimePaths } from './runtime-types'

const execFileAsync = promisify(execFile)

export interface AssetDownloadRequest {
  asset: RuntimeAsset
  target: string
  resumeFrom: number
  signal?: AbortSignal
}

export type AssetDownloader = (request: AssetDownloadRequest) => Promise<void>
export type ArchiveExtractor = (archive: string, destination: string, asset: RuntimeAsset) => Promise<void>
export type CommandRunner = (command: string, args: string[], cwd?: string) => Promise<void>

export interface PythonRuntimeOptions {
  userDataDir: string
  manifest: RuntimeManifest
  platform?: string
  devRoot?: string
  downloadAsset?: AssetDownloader
  extractArchive?: ArchiveExtractor
  runCommand?: CommandRunner
}

const defaultDownloadAsset: AssetDownloader = async ({ asset, target, resumeFrom, signal }) => {
  const headers: Record<string, string> = {}
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`
  const response = await fetch(asset.url, { headers, signal })
  if (!response.ok) throw new Error(`Runtime asset download failed: ${response.status}`)

  const append = resumeFrom > 0 && response.status === 206
  const file = await import('node:fs/promises').then(({ open }) => open(target, append ? 'a' : 'w'))
  try {
    if (!response.body) throw new Error('Runtime asset response has no body')
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      await file.write(chunk)
    }
  } finally {
    await file.close()
  }
}

const defaultExtractArchive: ArchiveExtractor = async (archive, destination) => {
  await mkdir(destination, { recursive: true })
  await execFileAsync('/usr/bin/tar', ['-xzf', archive, '-C', destination])
}

const defaultRunCommand: CommandRunner = async (command, args, cwd) => {
  await execFileAsync(command, args, { cwd })
}

function expectedPlatform(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  return `${process.platform}-${process.arch}`
}

function sha256File(path: string): Promise<string> {
  return readFile(path).then((contents) => createHash('sha256').update(contents).digest('hex'))
}

function ensureHttps(url: string): void {
  if (new URL(url).protocol !== 'https:') throw new Error(`Runtime asset URL must use HTTPS: ${url}`)
}

export class PythonRuntime {
  private readonly userDataDir: string
  private readonly manifest: RuntimeManifest
  private readonly platform: string
  private readonly devRoot: string | undefined
  private readonly downloadAsset: AssetDownloader
  private readonly extractArchive: ArchiveExtractor
  private readonly runCommand: CommandRunner

  constructor(options: PythonRuntimeOptions) {
    this.userDataDir = options.userDataDir
    this.manifest = options.manifest
    this.platform = options.platform ?? expectedPlatform()
    this.devRoot = options.devRoot
    this.downloadAsset = options.downloadAsset ?? defaultDownloadAsset
    this.extractArchive = options.extractArchive ?? defaultExtractArchive
    this.runCommand = options.runCommand ?? defaultRunCommand
  }

  private profileRoot(): string {
    return join(this.userDataDir, 'runtime', 'python', this.manifest.profile)
  }

  private packagedPython(): string {
    return join(this.profileRoot(), 'bin', 'python')
  }

  private developmentPaths(): RuntimePaths | null {
    if (!this.devRoot) return null
    const python = join(this.devRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
    return { python, appRoot: this.devRoot, profile: 'development' }
  }

  paths(): RuntimePaths | null {
    const python = this.packagedPython()
    const development = this.developmentPaths()
    if (development && existsSync(development.python)) return development
    if (existsSync(python)) return { python, appRoot: this.profileRoot(), profile: this.manifest.profile }
    return null
  }

  private asset(kind: RuntimeAsset['kind']): RuntimeAsset {
    const asset = this.manifest.assets.find((candidate) => candidate.kind === kind)
    if (!asset) throw new Error(`Runtime manifest is missing ${kind} asset`)
    ensureHttps(asset.url)
    return asset
  }

  private async ensureAsset(asset: RuntimeAsset, partName: string, signal?: AbortSignal): Promise<string> {
    const root = this.profileRoot()
    await mkdir(root, { recursive: true })
    const part = join(root, partName)
    try {
      const existing = await stat(part).catch(() => null)
      const resumeFrom = existing?.size ?? 0
      await this.downloadAsset({ asset, target: part, resumeFrom, signal })
      const actualSize = (await stat(part)).size
      if (actualSize !== asset.size) throw new Error(`Runtime asset size mismatch for ${asset.id}`)
      const actualHash = await sha256File(part)
      if (actualHash !== asset.sha256) throw new Error(`Runtime asset SHA-256 mismatch for ${asset.id}`)
      const finalPath = join(root, `${asset.id}-${asset.version}.asset`)
      await rename(part, finalPath)
      return finalPath
    } catch (error) {
      await rm(part, { force: true })
      throw error
    }
  }

  async ensureReady(signal?: AbortSignal): Promise<RuntimePaths> {
    if (this.manifest.platform !== this.platform) {
      throw new Error(`Runtime manifest targets ${this.manifest.platform}, current platform is ${this.platform}`)
    }
    const development = this.developmentPaths()
    if (development && await stat(development.python).then(() => true).catch(() => false)) return development

    const pythonAsset = this.asset('python-runtime')
    const uvAsset = this.asset('uv')
    const wheelhouseAsset = this.asset('wheelhouse')
    const pythonArchive = await this.ensureAsset(pythonAsset, '.python-runtime.part', signal)
    const uvFile = await this.ensureAsset(uvAsset, '.uv.part', signal)
    const wheelhouseArchive = await this.ensureAsset(wheelhouseAsset, '.wheelhouse.part', signal)

    const root = this.profileRoot()
    await this.extractArchive(pythonArchive, root, pythonAsset)
    const wheelhouseRoot = join(root, 'wheelhouse')
    await this.extractArchive(wheelhouseArchive, wheelhouseRoot, wheelhouseAsset)
    const uvPath = join(root, 'bin', 'uv')
    await mkdir(join(root, 'bin'), { recursive: true })
    await import('node:fs/promises').then(({ copyFile }) => copyFile(uvFile, uvPath))
    await chmod(uvPath, 0o755)

    const python = this.packagedPython()
    await stat(python)
    await this.runCommand(
      uvPath,
      [
        'pip',
        'install',
        '--python',
        python,
        '--no-index',
        '--find-links',
        wheelhouseRoot,
        'speech-to-speech',
        'speech-to-speech-gateway',
      ],
      root,
    )
    return { python, appRoot: root, profile: this.manifest.profile }
  }

  async dispose(): Promise<void> {}
}
