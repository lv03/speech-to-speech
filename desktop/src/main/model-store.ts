import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'

import type { RuntimeAsset, RuntimeManifest } from './runtime-types'

export interface ModelProgress {
  assetId: string
  completed: number
  total: number
}

export interface ModelStoreOptions {
  root: string
  manifest: RuntimeManifest
  fetch?: typeof fetch
  onProgress?: (event: ModelProgress) => void
}

function ensureHttps(url: string): void {
  if (new URL(url).protocol !== 'https:') throw new Error(`Model asset URL must use HTTPS: ${url}`)
}

function abortError(): DOMException {
  return new DOMException('Model download cancelled', 'AbortError')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ModelStore {
  private readonly root: string
  private readonly assets: Map<string, RuntimeAsset>
  private readonly fetchImpl: typeof fetch
  private readonly onProgress: ((event: ModelProgress) => void) | undefined
  private readonly active = new Map<string, AbortController>()

  constructor(options: ModelStoreOptions) {
    this.root = resolve(options.root)
    this.assets = new Map(options.manifest.assets.map((asset) => [asset.id, asset]))
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.onProgress = options.onProgress
  }

  private asset(assetId: string): RuntimeAsset {
    const asset = this.assets.get(assetId)
    if (!asset) throw new Error(`Unknown runtime asset: ${assetId}`)
    if (asset.kind !== 'model') throw new Error(`Runtime asset is not a model: ${assetId}`)
    ensureHttps(asset.url)
    return asset
  }

  private modelsRoot(): string {
    return join(this.root, 'qmd', 'cache', 'qmd', 'models')
  }

  private configPath(): string {
    return join(this.root, 'qmd', 'config', 'qmd', 'index.yml')
  }

  private finalPath(asset: RuntimeAsset): string {
    return join(this.modelsRoot(), `${asset.id}-${asset.version}.gguf`)
  }

  private partPath(asset: RuntimeAsset): string {
    return `${this.finalPath(asset)}.part`
  }

  private async writeModelConfig(path: string): Promise<void> {
    const configPath = this.configPath()
    let config: Record<string, unknown> = {}
    try {
      const parsed = parse(await readFile(configPath, 'utf8')) as unknown
      if (!isRecord(parsed)) throw new Error('QMD index.yml must contain a YAML mapping')
      config = parsed
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') throw error
    }

    // v1 only invokes vec-only search. Point every QMD model role at the
    // verified local asset so an accidental non-vec call cannot trigger an
    // implicit hf: download; rerank/generate are not loaded in this profile.
    config.models = { embed: path, rerank: path, generate: path }
    const directory = join(this.root, 'qmd', 'config', 'qmd')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${configPath}.tmp`
    await writeFile(temporary, stringify(config), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, configPath)
  }

  async inspect(assetId: string): Promise<{ present: boolean; bytes: number; sha256?: string }> {
    const asset = this.asset(assetId)
    const path = this.finalPath(asset)
    try {
      const metadata = await stat(path)
      if (!metadata.isFile()) return { present: false, bytes: 0 }
      const digest = createHash('sha256').update(await readFile(path)).digest('hex')
      if (metadata.size !== asset.size || digest !== asset.sha256) {
        await rm(path, { force: true })
        return { present: false, bytes: metadata.size, sha256: digest }
      }
      return { present: true, bytes: metadata.size, sha256: digest }
    } catch {
      return { present: false, bytes: 0 }
    }
  }

  async ensure(assetId: string, externalSignal?: AbortSignal): Promise<string> {
    const asset = this.asset(assetId)
    const destination = this.finalPath(asset)
    const existing = await this.inspect(assetId)
    if (existing.present) {
      await this.writeModelConfig(destination)
      return destination
    }
    if (this.active.has(assetId)) throw new Error(`Model asset is already downloading: ${assetId}`)

    const controller = new AbortController()
    this.active.set(assetId, controller)
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal
    const part = this.partPath(asset)
    await mkdir(this.modelsRoot(), { recursive: true, mode: 0o700 })

    try {
      const partial = await stat(part).catch(() => null)
      const resumeFrom = partial?.isFile() ? partial.size : 0
      const headers: Record<string, string> = {}
      if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`
      const response = await this.fetchImpl(asset.url, { headers, signal })
      if (!response.ok) throw new Error(`Model asset download failed: ${response.status}`)

      const append = resumeFrom > 0 && response.status === 206
      let completed = append ? resumeFrom : 0
      const file = await open(part, append ? 'a' : 'w', 0o600)
      try {
        if (!response.body) throw new Error('Model asset response has no body')
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          if (signal.aborted) throw abortError()
          await file.write(chunk)
          completed += chunk.byteLength
          this.onProgress?.({ assetId, completed, total: asset.size })
        }
      } finally {
        await file.close()
      }
      if (signal.aborted) throw abortError()

      const metadata = await stat(part)
      if (metadata.size !== asset.size) throw new Error(`Model asset size mismatch for ${asset.id}`)
      const digest = createHash('sha256').update(await readFile(part)).digest('hex')
      if (digest !== asset.sha256) throw new Error(`Model asset SHA-256 mismatch for ${asset.id}`)
      await rename(part, destination)
      await this.writeModelConfig(destination)
      return destination
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        await rm(part, { force: true })
      }
      throw error
    } finally {
      this.active.delete(assetId)
    }
  }

  cancel(assetId: string): void {
    this.active.get(assetId)?.abort()
  }
}
