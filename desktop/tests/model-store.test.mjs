import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
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

const response = (chunks, status = 200) => ({
  ok: true,
  status,
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

  expect(path).toBe(join(root, 'qmd', 'cache', 'qmd', 'models', 'embedding-1.0.0.gguf'))
  await expect(readFile(path, 'utf8')).resolves.toBe(content)
  await expect(readFile(join(root, 'qmd', 'config', 'qmd', 'index.yml'), 'utf8')).resolves.toContain(`embed: ${path}`)
  await expect(store.inspect('embedding')).resolves.toMatchObject({ present: true, bytes: content.length })
  expect(progress.at(-1)).toMatchObject({ assetId: 'embedding', completed: content.length, total: content.length })
})

test('resumes a partial model download with a Range request', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-model-'))
  const content = 'embedding-model'
  const asset = modelAsset(content)
  const part = join(root, 'qmd', 'cache', 'qmd', 'models', `${asset.id}-${asset.version}.gguf.part`)
  await mkdir(join(root, 'qmd', 'cache', 'qmd', 'models'), { recursive: true })
  await writeFile(part, 'embedding-')
  let request
  const store = new ModelStore({
    root,
    manifest: { schemaVersion: 1, platform: 'darwin-arm64', pythonAbi: 'cp311', profile: 'voice-default', assets: [asset] },
    fetch: async (_url, init) => {
      request = init
      return response(['model'], 206)
    },
  })

  const path = await store.ensure('embedding')

  expect(request.headers.Range).toBe('bytes=10-')
  await expect(readFile(path, 'utf8')).resolves.toBe(content)
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
  await expect(readdir(join(root, 'qmd', 'cache', 'qmd', 'models'))).resolves.toContain('embedding-1.0.0.gguf.part')

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
  await expect(readdir(join(invalidRoot, 'qmd', 'cache', 'qmd', 'models'))).resolves.not.toContain('embedding-1.0.0.gguf.part')
})
