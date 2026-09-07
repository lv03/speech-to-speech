import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { RuntimeManifest, RuntimePaths } from './runtime-types'

const execFileAsync = promisify(execFile)

export interface RuntimeCommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

export type RuntimeCommandRunner = (
  command: string,
  args: string[],
  options: RuntimeCommandOptions,
) => Promise<unknown>

export interface PythonRuntimeOptions {
  userDataDir: string
  manifest: RuntimeManifest
  platform?: string
  /** Absolute path to the packaged resources/runtime directory. */
  packagedRoot?: string
  /** Explicit checkout root permitted only by the development entrypoint. */
  devRoot?: string
  /** Injectable command boundary for tests; production uses the packaged Python process. */
  commandRunner?: RuntimeCommandRunner
}

function expectedPlatform(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  return `${process.platform}-${process.arch}`
}

function runtimePython(root: string): string {
  return join(root, 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
}

function runtimeVenvPython(root: string): string {
  return join(root, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
}

function commandEnvironment(basePython: string, userDataDir: string): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_TRUSTED_HOST']) {
    delete environment[key]
  }
  return {
    ...environment,
    PATH: dirname(basePython),
    PYTHONNOUSERSITE: '1',
    PIP_NO_INDEX: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_CACHE_DIR: join(userDataDir, 'runtime', 'python', 'pip-cache'),
  }
}

function inside(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

/**
 * Resolves the one Python runtime used by gateway, voice and voiceprint.
 *
 * Packaged mode carries a read-only standalone interpreter and wheelhouse in
 * application resources. Its dependencies are installed once into an
 * app-private venv with pip forced into offline mode. Development mode keeps
 * using the explicitly supplied checkout venv.
 */
export class PythonRuntime {
  private readonly manifest: RuntimeManifest
  private readonly platform: string
  private readonly userDataDir: string
  private readonly packagedRoot: string | undefined
  private readonly devRoot: string | undefined
  private readonly commandRunner: RuntimeCommandRunner
  private readyPaths: RuntimePaths | null = null
  private readyPromise: Promise<RuntimePaths> | null = null

  constructor(options: PythonRuntimeOptions) {
    this.manifest = options.manifest
    this.platform = options.platform ?? expectedPlatform()
    this.userDataDir = resolve(options.userDataDir)
    this.packagedRoot = options.packagedRoot ? resolve(options.packagedRoot) : undefined
    this.devRoot = options.devRoot ? resolve(options.devRoot) : undefined
    this.commandRunner = options.commandRunner ?? (async (command, args, commandOptions) => {
      await execFileAsync(command, args, {
        ...commandOptions,
        maxBuffer: 64 * 1024,
      })
    })
  }

  private developmentPaths(): RuntimePaths | null {
    if (!this.devRoot) return null
    const python = process.platform === 'win32'
      ? join(this.devRoot, '.venv', 'Scripts', 'python.exe')
      : join(this.devRoot, '.venv', 'bin', 'python')
    return { python, appRoot: this.devRoot, profile: 'development' }
  }

  private packagedBasePaths(): RuntimePaths | null {
    if (!this.packagedRoot) return null
    const python = runtimePython(this.packagedRoot)
    if (!existsSync(python)) return null
    return { python, appRoot: this.packagedRoot, profile: this.manifest.profile }
  }

  private packagedVenvRoot(): string {
    return join(this.userDataDir, 'runtime', 'python', 'venv')
  }

  private packagedStampPath(): string {
    return join(this.userDataDir, 'runtime', 'python', 'install.json')
  }

  private async wheelhouseFingerprint(wheelhouse: string): Promise<string> {
    const entries = await readdir(wheelhouse, { withFileTypes: true })
    const wheels = []
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.whl')).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(wheelhouse, entry.name)
      const [metadata, contents, realWheelhouse, realPath] = await Promise.all([
        stat(path),
        readFile(path),
        realpath(wheelhouse),
        realpath(path),
      ])
      if (!metadata.isFile() || !inside(realWheelhouse, realPath)) {
        throw new Error('Packaged Python wheelhouse contains an invalid wheel')
      }
      wheels.push({ name: entry.name, size: metadata.size, sha256: createHash('sha256').update(contents).digest('hex') })
    }
    return createHash('sha256').update(JSON.stringify(wheels)).digest('hex')
  }

  private async packagedFingerprint(applicationWheel: string, wheelhouse: string): Promise<string> {
    const runtimeAssets = this.manifest.assets
      .filter((asset) => asset.kind === 'python-runtime' || asset.kind === 'wheelhouse')
      .map((asset) => ({ id: asset.id, version: asset.version, sha256: asset.sha256 }))
    const wheelMetadata = await stat(applicationWheel)
    const wheelhouseSha256 = await this.wheelhouseFingerprint(wheelhouse)
    const input = JSON.stringify({
      platform: this.platform,
      pythonAbi: this.manifest.pythonAbi,
      profile: this.manifest.profile,
      assets: runtimeAssets,
      applicationWheel: { name: applicationWheel.slice(applicationWheel.lastIndexOf('/') + 1), size: wheelMetadata.size },
      wheelhouseSha256,
    })
    return createHash('sha256').update(input).digest('hex')
  }

  private async applicationWheel(wheelhouse: string): Promise<string> {
    let entries
    try {
      const metadata = await stat(wheelhouse)
      if (!metadata.isDirectory()) throw new Error('wheelhouse is not a directory')
      entries = await readdir(wheelhouse, { withFileTypes: true })
    } catch {
      throw new Error('Packaged Python wheelhouse is unavailable')
    }
    const wheels = entries
      .filter((entry) => entry.isFile() && /^speech_to_speech[-_][^/]+\.whl$/i.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
    if (wheels.length === 0) throw new Error('Packaged Python wheelhouse has no application wheel')
    return join(wheelhouse, wheels[0].name)
  }

  private async installedPackagedPaths(base: RuntimePaths, fingerprint: string): Promise<RuntimePaths | null> {
    const venvRoot = this.packagedVenvRoot()
    const python = runtimeVenvPython(venvRoot)
    if (!existsSync(python)) return null
    try {
      const stamp = JSON.parse(await readFile(this.packagedStampPath(), 'utf8')) as { fingerprint?: unknown }
      if (stamp.fingerprint !== fingerprint) return null
    } catch {
      return null
    }
    return { python, appRoot: base.appRoot, profile: base.profile }
  }

  private async installPackaged(base: RuntimePaths, wheelhouse: string, applicationWheel: string, fingerprint: string): Promise<RuntimePaths> {
    const pythonRoot = join(this.userDataDir, 'runtime', 'python')
    const venvRoot = this.packagedVenvRoot()
    const temporaryRoot = `${venvRoot}.${process.pid}.${Date.now()}.tmp`
    await mkdir(pythonRoot, { recursive: true, mode: 0o700 })
    await rm(temporaryRoot, { recursive: true, force: true })

    const environment = commandEnvironment(base.python, this.userDataDir)
    try {
      await this.commandRunner(base.python, ['-m', 'venv', '--symlinks', temporaryRoot], {
        cwd: base.appRoot,
        env: environment,
      })
      const temporaryPython = runtimeVenvPython(temporaryRoot)
      if (!existsSync(temporaryPython)) throw new Error('venv creation did not produce a Python executable')
      await this.commandRunner(temporaryPython, [
        '-m', 'pip', 'install',
        '--no-index',
        '--pre',
        '--no-cache-dir',
        '--disable-pip-version-check',
        '--only-binary=:all:',
        '--find-links', wheelhouse,
        applicationWheel,
      ], {
        cwd: base.appRoot,
        env: environment,
      })
      await this.commandRunner(temporaryPython, ['-c', 'import gateway, speech_to_speech'], {
        cwd: base.appRoot,
        env: environment,
      })
      await rm(venvRoot, { recursive: true, force: true })
      await rename(temporaryRoot, venvRoot)
      const stampPath = this.packagedStampPath()
      const temporaryStamp = `${stampPath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporaryStamp, `${JSON.stringify({ fingerprint }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporaryStamp, stampPath)
      return { python: runtimeVenvPython(venvRoot), appRoot: base.appRoot, profile: base.profile }
    } catch {
      await rm(temporaryRoot, { recursive: true, force: true })
      throw new Error('Packaged Python dependencies could not be installed from the locked wheelhouse')
    }
  }

  private async ensurePackaged(): Promise<RuntimePaths> {
    const base = this.packagedBasePaths()
    if (!base) throw new Error('Packaged Python runtime is unavailable')
    const wheelhouse = join(base.appRoot, 'wheelhouse')
    const [realRoot, realWheelhouse] = await Promise.all([realpath(base.appRoot), realpath(wheelhouse)]).catch(() => {
      throw new Error('Packaged Python wheelhouse is unavailable')
    })
    if (!inside(realRoot, realWheelhouse)) throw new Error('Packaged Python wheelhouse escapes the application resources')
    const applicationWheel = await this.applicationWheel(wheelhouse)
    const fingerprint = await this.packagedFingerprint(applicationWheel, wheelhouse)
    const installed = await this.installedPackagedPaths(base, fingerprint)
    if (installed) return installed
    return this.installPackaged(base, wheelhouse, applicationWheel, fingerprint)
  }

  paths(): RuntimePaths | null {
    if (this.readyPaths) return this.readyPaths
    if (this.packagedRoot) return this.packagedBasePaths()
    const development = this.developmentPaths()
    return development && existsSync(development.python) ? development : null
  }

  async ensureReady(): Promise<RuntimePaths> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        if (this.manifest.platform !== this.platform) {
          throw new Error(`Runtime manifest targets ${this.manifest.platform}, current platform is ${this.platform}`)
        }

        if (this.packagedRoot) return this.ensurePackaged()

        const development = this.developmentPaths()
        if (development && existsSync(development.python)) return development
        throw new Error('Python runtime is unavailable; configure an explicit development root or packaged runtime')
      })()
        .then((paths) => {
          this.readyPaths = paths
          return paths
        })
        .catch((error) => {
          this.readyPromise = null
          throw error
        })
    }
    return this.readyPromise
  }

  async dispose(): Promise<void> {}
}
