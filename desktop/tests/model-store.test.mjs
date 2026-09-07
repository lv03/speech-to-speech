import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { ModelStore } from '../src/main/model-store'

const hash = (value) => createHash('sha256').update(value).digest('hex')

const modelAsset = (content, overrides = {}) => ({
  id: 'embedding',
  version: '1.0.0',
  kind: 'model',
  url: 'https://models.example/embedding.gguf',
  size: Buffer.byteLength(content),
  sha256: hash(content),
  ...overrides,
})

const response = (chunks, status = 200, headers = {}) => ({
  ok: true,
  status,
  headers: new Headers(headers),
  body: (async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk)
  })(),
})

test('downloads a model, reports progress, and returns a verified asset path', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-model-'))
  const content = 'embedding-model'
  const progress = []
  const store = new ModelStore({
    root,
    manifest: { schemaVersion: 1, platform: 'darwin-arm64', pythonAbi: 'cp311', profile: 'voice-default', assets: [modelAsset(content)] },
    fetch: async () => response(['embedding-', 'model']),
    onProgress: (event) => progress.push(event),
  })

  const path = await store.ensure('embedding')

  expect(path).toBe(join(root, 'runtime', 'models', 'embedding-1.0.0.gguf'))
  await expect(readFile(path, 'utf8')).resolves.toBe(content)
  const config = await readFile(join(root, 'qmd', 'config', 'qmd', 'index.yml'), 'utf8')
  expect(config).toContain(`embed: ${path}`)
  expect(config).not.toContain('rerank:')
  expect(config).not.toContain('generate:')
  await expect(store.inspect('embedding')).resolves.toMatchObject({ present: true, bytes: content.length })
  expect(progress.at(-1)).toMatchObject({ assetId: 'embedding', completed: content.length, total: content.length })
  expect((await stat(join(root, 'qmd'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(root, 'qmd', 'cache'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(root, 'qmd', 'cache', 'qmd'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(root, 'runtime', 'models'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(root, 'runtime', 'models', 'embedding-1.0.0.gguf'))).mode & 0o777).toBe(0o600)
  expect((await stat(join(root, 'qmd', 'config', 'qmd'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(root, 'qmd', 'config'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(root, 'qmd', 'config', 'qmd', 'index.yml'))).mode & 0o777).toBe(0o600)
})

test('configures an already installed model without making a network request', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-model-installed-'))
  const content = 'embedding-model'
  const asset = modelAsset(content)
  const modelPath = join(root, 'runtime', 'models', 'embedding-1.0.0.gguf')
  await mkdir(join(root, 'runtime', 'models'), { recursive: true })
  await writeFile(modelPath, content)
  const store = new ModelStore({
    root,
    manifest: { schemaVersion: 1, platform: 'darwin-arm64', pythonAbi: 'cp311', profile: 'voice-default', assets: [asset] },
    fetch: async () => { throw new Error('installed models must not download') },
  })

  await expect(store.ensureInstalled('embedding')).resolves.toBe(modelPath)
  await expect(readFile(join(root, 'qmd', 'config', 'qmd', 'index.yml'), 'utf8')).resolves.toContain(`embed: ${modelPath}`)
})

test('resumes a partial model download with a Range request', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-model-'))
  const content = 'embedding-model'
  const asset = modelAsset(content)
  const part = join(root, 'runtime', 'models', `${asset.id}-${asset.version}.gguf.part`)
  await mkdir(join(root, 'runtime', 'models'), { recursive: true })
  await writeFile(part, 'embedding-')
  let request
  const store = new ModelStore({
    root,
    manifest: { schemaVersion: 1, platform: 'darwin-arm64', pythonAbi: 'cp311', profile: 'voice-default', assets: [asset] },
    fetch: async (_url, init) => {
      request = init
      return response(['model'], 206, { 'content-range': 'bytes 10-14/15' })
    },
  })
  await expect(store.inspect('embedding')).resolves.toMatchObject({ present: false, partialBytes: 10 })

  const path = await store.ensure('embedding')

  expect(request.headers.Range).toBe('bytes=10-')
  await expect(readFile(path, 'utf8')).resolves.toBe(content)
})

test('rejects HTTP 200 when resuming an existing partial model', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-model-range-'))
  const content = 'embedding-model'
  const asset = modelAsset(content)
  const models = join(root, 'runtime', 'models')
  const part = join(models, `${asset.id}-${asset.version}.gguf.part`)
  await mkdir(models, { recursive: true })
  await writeFile(part, 'embedding-')
  const store = new ModelStore({
    root,
    manifest: { schemaVersion: 1, platform: 'darwin-arm64', pythonAbi: 'cp311', profile: 'voice-default', assets: [asset] },
    fetch: async () => response(['model'], 200),
  })

  await expect(store.ensure('embedding')).rejects.toThrow(/206|range/i)
  await expect(stat(part)).rejects.toThrow()
})

test('repairs permissions on an already installed model and directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-model-permissions-'))
  const content = 'embedding-model'
  const asset = modelAsset(content)
  const models = join(root, 'runtime', 'models')
  const path = join(models, `${asset.id}-${asset.version}.gguf`)
  await mkdir(models, { recursive: true })
  await mkdir(join(root, 'qmd', 'cache', 'qmd'), { recursive: true })
  await mkdir(join(root, 'qmd', 'config', 'qmd'), { recursive: true })
  for (const directory of [
    join(root, 'runtime'),
    join(root, 'qmd'),
    join(root, 'qmd', 'cache'),
    join(root, 'qmd', 'cache', 'qmd'),
    models,
    join(root, 'qmd', 'config'),
    join(root, 'qmd', 'config', 'qmd'),
  ]) {
    await chmod(directory, 0o755)
  }
  await writeFile(path, content, { mode: 0o644 })
  const store = new ModelStore({
    root,
    manifest: { schemaVersion: 1, platform: 'darwin-arm64', pythonAbi: 'cp311', profile: 'voice-default', assets: [asset] },
    fetch: async () => { throw new Error('download must not run') },
  })

  await store.ensure('embedding')

  expect((await stat(models)).mode & 0o777).toBe(0o700)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
})

test('rejects a partial response without a matching Content-Range', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-model-range-'))
  const content = 'embedding-model'
  const asset = modelAsset(content)
  const part = join(root, 'runtime', 'models', `${asset.id}-${asset.version}.gguf.part`)
  await mkdir(join(root, 'runtime', 'models'), { recursive: true })
  await writeFile(part, 'embedding-')
  const store = new ModelStore({
    root,
    manifest: { schemaVersion: 1, platform: 'darwin-arm64', pythonAbi: 'cp311', profile: 'voice-default', assets: [asset] },
    fetch: async () => response(['model'], 206),
  })

  await expect(store.ensure('embedding')).rejects.toThrow('Content-Range')
  await expect(readdir(join(root, 'runtime', 'models'))).resolves.not.toContain('embedding-1.0.0.gguf.part')
})

test('keeps a partial file on cancellation and removes it after verification failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-model-'))
  const content = 'embedding-model'
  const asset = modelAsset(content)
  let abortDownload
  const store = new ModelStore({
    root,
    manifest: { schemaVersion: 1, platform: 'darwin-arm64', pythonAbi: 'cp311', profile: 'voice-default', assets: [asset] },
    fetch: async (_url, init) => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield Buffer.from('partial')
        await new Promise((resolve) => {
          abortDownload = resolve
          init.signal.addEventListener('abort', resolve, { once: true })
        })
      })(),
    }),
  })

  const pending = store.ensure('embedding')
  while (!abortDownload) await new Promise((resolve) => setTimeout(resolve, 1))
  store.cancel('embedding')
  abortDownload()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await expect(readdir(join(root, 'runtime', 'models'))).resolves.toContain('embedding-1.0.0.gguf.part')

  const invalidRoot = await mkdtemp(join(tmpdir(), 's2s-model-invalid-'))
  const invalidStore = new ModelStore({
    root: invalidRoot,
    manifest: {
      schemaVersion: 1,
      platform: 'darwin-arm64',
      pythonAbi: 'cp311',
      profile: 'voice-default',
      assets: [modelAsset(content, { sha256: '0'.repeat(64) })],
    },
    fetch: async () => response([content]),
  })
  await expect(invalidStore.ensure('embedding')).rejects.toThrow('SHA-256')
  await expect(readdir(join(invalidRoot, 'runtime', 'models'))).resolves.not.toContain('embedding-1.0.0.gguf.part')
})
