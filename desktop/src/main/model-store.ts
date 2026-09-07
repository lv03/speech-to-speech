import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'

import type { RuntimeAsset, RuntimeManifest } from './runtime-types'

export interface ModelProgress {
  assetId: string
  completed: number
  total: number
}

export type ModelProgressListener = (event: ModelProgress) => void

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
  private readonly progressListeners = new Set<ModelProgressListener>()
  private readonly active = new Map<string, AbortController>()

  constructor(options: ModelStoreOptions) {
    this.root = resolve(options.root)
    this.assets = new Map(options.manifest.assets.map((asset) => [asset.id, asset]))
    this.fetchImpl = options.fetch ?? globalThis.fetch
    if (options.onProgress) this.progressListeners.add(options.onProgress)
  }

  onProgress(listener: ModelProgressListener): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  private emitProgress(event: ModelProgress): void {
    for (const listener of this.progressListeners) listener(event)
  }

  private asset(assetId: string): RuntimeAsset {
    const asset = this.assets.get(assetId)
    if (!asset) throw new Error(`Unknown runtime asset: ${assetId}`)
    if (asset.kind !== 'model') throw new Error(`Runtime asset is not a model: ${assetId}`)
    ensureHttps(asset.url)
    return asset
  }

  private modelsRoot(): string {
    return join(this.root, 'runtime', 'models')
  }

  private async privateQmdDirectories(): Promise<void> {
    const qmdRoot = join(this.root, 'qmd')
    for (const directory of [
      join(this.root, 'runtime'),
      join(this.root, 'runtime', 'models'),
      qmdRoot,
      join(qmdRoot, 'cache'),
      join(qmdRoot, 'cache', 'qmd'),
      join(qmdRoot, 'config'),
      join(qmdRoot, 'config', 'qmd'),
    ]) {
      await this.privateDirectory(directory)
    }
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

  private async privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
  }

  private async privateFile(path: string): Promise<void> {
    await chmod(path, 0o600)
  }

  private async writeModelConfig(): Promise<void> {
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

    const models: Record<string, string> = {}
    for (const asset of this.assets.values()) {
      if (asset.kind !== 'model') continue
      const modelPath = this.finalPath(asset)
      try {
        const metadata = await stat(modelPath)
        if (!metadata.isFile()) continue
        if (asset.role === 'embedding' || asset.id === 'embedding') models.embed = modelPath
        if (asset.role === 'reranker' || asset.id === 'reranker' || asset.id === 'rerank') models.rerank = modelPath
        if (asset.role === 'generator' || asset.id === 'generator' || asset.id === 'generation') models.generate = modelPath
      } catch {
        // Only verified, installed model files may be configured.
      }
    }
    if (!models.embed) throw new Error('Embedding model is not installed')
    config.models = models
    await this.privateQmdDirectories()
    const temporary = `${configPath}.tmp`
    await writeFile(temporary, stringify(config), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, configPath)
    await this.privateFile(configPath)
  }

  /** Validate an installed asset and refresh QMD's private model config without downloading. */
  async ensureInstalled(assetId: string): Promise<string> {
    const asset = this.asset(assetId)
    const inspected = await this.inspect(assetId)
    if (!inspected.present) throw new Error(`Model asset is not installed: ${assetId}`)
    await this.writeModelConfig()
    return this.finalPath(asset)
  }

  async inspect(assetId: string): Promise<{ present: boolean; bytes: number; partialBytes?: number; sha256?: string }> {
    const asset = this.asset(assetId)
    const path = this.finalPath(asset)
    await this.privateQmdDirectories()
    try {
      const metadata = await stat(path)
      if (!metadata.isFile()) return { present: false, bytes: 0 }
      const digest = createHash('sha256').update(await readFile(path)).digest('hex')
      if (metadata.size !== asset.size || digest !== asset.sha256) {
        await rm(path, { force: true })
        return { present: false, bytes: metadata.size, partialBytes: 0, sha256: digest }
      }
      await this.privateFile(path)
      return { present: true, bytes: metadata.size, partialBytes: 0, sha256: digest }
    } catch {
      try {
        const partial = await stat(this.partPath(asset))
        return { present: false, bytes: 0, partialBytes: partial.isFile() ? partial.size : 0 }
      } catch {
        return { present: false, bytes: 0, partialBytes: 0 }
      }
    }
  }

  async ensure(assetId: string, externalSignal?: AbortSignal): Promise<string> {
    const asset = this.asset(assetId)
    const destination = this.finalPath(asset)
    const existing = await this.inspect(assetId)
    if (existing.present) {
      return this.ensureInstalled(assetId)
    }
    if (this.active.has(assetId)) throw new Error(`Model asset is already downloading: ${assetId}`)

    const controller = new AbortController()
    this.active.set(assetId, controller)
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal
    const part = this.partPath(asset)
    await this.privateQmdDirectories()

    try {
      const partial = await stat(part).catch(() => null)
      const resumeFrom = partial?.isFile() ? partial.size : 0
      if (resumeFrom > 0) await this.privateFile(part)
      const headers: Record<string, string> = {}
      if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`
      const response = await this.fetchImpl(asset.url, { headers, signal })
      if (!response.ok) throw new Error(`Model asset download failed: ${response.status}`)

      if (resumeFrom > 0) {
        if (response.status !== 206) throw new Error(`Model asset resume requires HTTP 206 for ${asset.id}`)
        const contentRange = response.headers.get('content-range') ?? ''
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange)
        if (!match || Number(match[1]) !== resumeFrom || Number(match[2]) < Number(match[1]) || Number(match[3]) !== asset.size) {
          throw new Error(`Model asset response has invalid Content-Range for ${asset.id}`)
        }
      } else if (response.status !== 200) {
        throw new Error(`Model asset download requires HTTP 200 for ${asset.id}`)
      }

      const append = resumeFrom > 0 && response.status === 206
      let completed = append ? resumeFrom : 0
      const file = await open(part, append ? 'a' : 'w', 0o600)
      try {
        await this.privateFile(part)
        if (!response.body) throw new Error('Model asset response has no body')
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          if (signal.aborted) throw abortError()
          await file.write(chunk)
          completed += chunk.byteLength
          this.emitProgress({ assetId, completed, total: asset.size })
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
      await this.privateFile(destination)
      await this.writeModelConfig()
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
