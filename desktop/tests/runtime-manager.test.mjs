import { expect, test } from 'vitest'

import { RuntimeManager } from '../src/main/runtime-manager'

function record(id, indexState = 'pending') {
  return {
    collectionId: id,
    displayName: 'Notes',
    root: '/private/notes',
    include: '**/*.md',
    enabled: true,
    lastIndexedAt: indexState === 'ready' ? '2026-09-05T00:00:00.000Z' : null,
    indexState,
  }
}

function fakeService() {
  const calls = []
  let collections = []
  let client = null
  return {
    calls,
    setClient(value) {
      client = value
      calls.push(['set-client', value])
    },
    async snapshot() {
      return {
        state: { name: collections.length ? 'indexing' : 'no_collection', updatedAt: '2026-09-05T00:00:00.000Z' },
        collections: collections.map((item) => ({ ...item })),
      }
    },
    async addCollection() {
      const item = record(collections.length === 0
        ? 'col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        : 'col_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
      collections.push(item)
      calls.push(['add'])
      return { ...item }
    },
    addPendingCollection() {
      const item = record('col_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
      collections.push(item)
      return item
    },
    addReadyCollection() {
      const item = record('col_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'ready')
      collections.push(item)
      return item
    },
    addDisabledPendingCollection() {
      const item = { ...record('col_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), enabled: false }
      collections.push(item)
      return item
    },
    disableAllCollections() {
      collections = collections.map((item) => ({ ...item, enabled: false }))
    },
    async removeCollection(id) {
      calls.push(['remove', id])
      collections = collections.filter((item) => item.collectionId !== id)
    },
    async reindex(id) {
      calls.push(['reindex', id, client])
      const item = collections.find((candidate) => candidate.collectionId === id)
      item.indexState = 'ready'
      item.lastIndexedAt = '2026-09-05T00:00:00.000Z'
    },
    async deleteIndex(id) {
      calls.push(['delete-index', id])
      const item = collections.find((candidate) => candidate.collectionId === id)
      item.indexState = 'pending'
      item.lastIndexedAt = null
    },
  }
}

function fakeModelStore(events, present = false, failEnsure = false, holdEnsure = false, assetIds = ['embedding'], assetSizes = { embedding: 100 }) {
  const installed = new Set(present ? assetIds : [])
  let progressListener
  let releaseEnsure
  return {
    onProgress(listener) {
      progressListener = listener
      return () => { progressListener = undefined }
    },
    emitProgress(event) {
      progressListener?.(event)
    },
    async inspect(assetId) {
      return installed.has(assetId)
        ? { present: true, bytes: assetSizes[assetId] ?? 100, partialBytes: 0 }
        : { present: false, bytes: 0, partialBytes: 0 }
    },
    async ensure(assetId, signal) {
      events.push(assetId === 'embedding' ? 'model.ensure' : `model.ensure:${assetId}`)
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      if (failEnsure) throw new Error('model checksum mismatch')
      if (holdEnsure) {
        await new Promise((resolve) => { releaseEnsure = resolve })
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      }
      installed.add(assetId)
      return `/private/userData/runtime/models/${assetId}-1.gguf`
    },
    async ensureInstalled(assetId) {
      events.push(assetId === 'embedding' ? 'model.ensure-installed' : `model.ensure-installed:${assetId}`)
      if (!installed.has(assetId)) throw new Error(`missing model: ${assetId}`)
      return `/private/userData/runtime/models/${assetId}-1.gguf`
    },
    release() {
      releaseEnsure?.()
      releaseEnsure = undefined
    },
    cancel(assetId) {
      events.push(assetId === 'embedding' ? 'model.cancel' : `model.cancel:${assetId}`)
    },
  }
}

function fakeDependencies({ present = false, memoryEnabled = false, failStarts = 0, failEnsure = false, failInitialize = false, failStop = false, holdEnsure = false, holdQuery = false, watchdogIntervalMs = 0, trackProxy = false, modelAssetSizes = { embedding: 100 }, retrievalProfiles, retrievalPreference = 'auto' } = {}) {
  const events = []
  let healthy = true
  let releaseQuery
  const service = fakeService()
  const modelStore = fakeModelStore(events, present, failEnsure, holdEnsure, Object.keys(modelAssetSizes), modelAssetSizes)
  const exitListeners = new Set()
  const qmdRuntime = {
    endpoint: null,
    onExit(listener) {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    async start() {
      events.push('qmd.start')
      healthy = true
      if (failStarts > 0) {
        failStarts -= 1
        throw new Error('QMD daemon failed to start')
      }
      qmdRuntime.endpoint = { baseUrl: 'http://[::1]:4123/mcp', port: 4123 }
      return qmdRuntime.endpoint
    },
    async health() {
      events.push('qmd.health')
      return healthy
    },
    async stop() {
      events.push('qmd.stop')
      if (failStop) throw new Error('QMD daemon stop failed')
    },
  }
  const qmdClient = {
    reset() {
      events.push('qmd.reset')
    },
    async initialize() {
      events.push('qmd.initialize')
      if (failInitialize) throw new Error('MCP initialize failed')
      return { version: '2.8.3' }
    },
    async status() {
      events.push('qmd.status')
      return { totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }
    },
    async query() {
      events.push('qmd.query')
      if (holdQuery) await new Promise((resolve) => { releaseQuery = resolve })
      return []
    },
    async get() { return '' },
  }
  const result = {
    events,
    service,
    modelStore,
    qmdRuntime,
    qmdClient,
    manager: new RuntimeManager({
      service,
      modelStore,
      modelAssetId: 'embedding',
      modelDownloadBytes: 100,
      modelDiskBytes: 100,
      modelAssetSizes,
      retrievalProfiles,
      retrievalPreference,
      memoryEnabled,
      qmdRuntime,
      qmdClient,
      invalidateHandles: trackProxy ? () => events.push('proxy.invalidate') : undefined,
      sleep: async (milliseconds) => events.push(`sleep:${milliseconds}`),
      watchdogIntervalMs,
    }),
  }
  return {
    ...result,
    setQmdHealthy(value) {
      healthy = value
    },
    failNextStarts(count) {
      failStarts = count
    },
    releaseQuery() {
      releaseQuery?.()
      releaseQuery = undefined
    },
    crash() {
      healthy = false
      for (const listener of exitListeners) listener({ unexpected: true, code: 1, signal: 'SIGTERM' })
    },
  }
}

test('invalidates proxy handles for every collection mutation', async () => {
  const dependencies = fakeDependencies({ trackProxy: true })
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  await dependencies.manager.deleteIndex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  await dependencies.manager.removeCollection('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

  expect(dependencies.events.filter((event) => event === 'proxy.invalidate').length).toBeGreaterThanOrEqual(4)
})

test('does not start a second QMD daemon while an indexing operation is active', async () => {
  const dependencies = fakeDependencies({ holdQuery: true })
  await dependencies.manager.addCollection('/private/notes')
  const pending = dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  while (!dependencies.events.includes('qmd.query')) await new Promise((resolve) => setTimeout(resolve, 0))
  dependencies.crash()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(dependencies.events.filter((event) => event === 'qmd.start')).toHaveLength(1)
  dependencies.releaseQuery()
  await expect(pending).rejects.toThrow('preparation failed')
})

test('does not download a model or start QMD when no collection exists', async () => {
  const { manager, events } = fakeDependencies()

  await expect(manager.snapshot()).resolves.toMatchObject({ state: { name: 'no_collection' } })
  await expect(manager.modelStatus()).resolves.toMatchObject({ state: 'not_needed', downloadBytes: 0, diskBytes: 0 })
  expect(events).toEqual([])
})

test('restores an existing ready index without downloading or indexing', async () => {
  const dependencies = fakeDependencies({ present: true })
  dependencies.service.addReadyCollection()

  await dependencies.manager.restoreExistingIndexes()

  expect(dependencies.events).toContain('qmd.start')
  expect(dependencies.events).toContain('qmd.initialize')
  expect(dependencies.events).toContain('qmd.status')
  expect(dependencies.events).toContain('qmd.query')
  expect(dependencies.events).not.toContain('model.ensure')
  expect(dependencies.events).toContain('model.ensure-installed')
  expect(dependencies.service.calls.map((call) => call[0])).not.toContain('reindex')
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'ready_vec' } })
})

test('aggregates progress and cancellation across every selected hybrid asset', async () => {
  const dependencies = fakeDependencies({
    holdEnsure: true,
    modelAssetSizes: { embedding: 100, reranker: 60, generator: 50 },
    retrievalProfiles: {
      vecOnly: { mode: 'vec-only', embeddingAssetId: 'embedding' },
      hybrid: { mode: 'hybrid', embeddingAssetId: 'embedding', rerankerAssetId: 'reranker', generatorAssetId: 'generator' },
    },
    retrievalPreference: 'hybrid',
  })
  await dependencies.manager.addCollection('/private/notes')
  const pending = dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  while (!dependencies.events.includes('model.ensure')) await new Promise((resolve) => setTimeout(resolve, 0))
  dependencies.modelStore.emitProgress({ assetId: 'embedding', completed: 30, total: 100 })
  dependencies.modelStore.emitProgress({ assetId: 'reranker', completed: 20, total: 60 })
  dependencies.modelStore.emitProgress({ assetId: 'generator', completed: 10, total: 50 })
  await new Promise((resolve) => setTimeout(resolve, 0))

  await expect(dependencies.manager.modelStatus()).resolves.toMatchObject({
    state: 'downloading',
    downloadBytes: 210,
    diskBytes: 210,
    completedBytes: 60,
  })
  dependencies.manager.cancel()
  expect(dependencies.events).toEqual(expect.arrayContaining(['model.cancel', 'model.cancel:reranker', 'model.cancel:generator']))
  dependencies.modelStore.release()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
})

test('auto prefers the approved hybrid profile over vec-only', async () => {
  const dependencies = fakeDependencies({
    present: false,
    modelAssetSizes: { embedding: 100, reranker: 60, generator: 50 },
    retrievalProfiles: {
      vecOnly: { mode: 'vec-only', embeddingAssetId: 'embedding' },
      hybrid: { mode: 'hybrid', embeddingAssetId: 'embedding', rerankerAssetId: 'reranker', generatorAssetId: 'generator' },
    },
    retrievalPreference: 'auto',
  })

  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  expect(dependencies.events).toContain('model.ensure')
  expect(dependencies.events).toContain('model.ensure:reranker')
  expect(dependencies.events).toContain('model.ensure:generator')
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'ready_hybrid' } })
})

test('rejects hybrid when the manifest does not provide an approved hybrid profile', async () => {
  const dependencies = fakeDependencies({
    retrievalProfiles: {
      vecOnly: { mode: 'vec-only', embeddingAssetId: 'embedding' },
      hybrid: null,
    },
  })

  await expect(dependencies.manager.setRetrievalPreference('hybrid')).rejects.toThrow(/unavailable/i)
})

test('switching retrieval profiles invalidates ready indexes until an explicit reindex', async () => {
  const dependencies = fakeDependencies({
    present: true,
    modelAssetSizes: { embedding: 100, reranker: 60, generator: 50 },
    retrievalProfiles: {
      vecOnly: { mode: 'vec-only', embeddingAssetId: 'embedding' },
      hybrid: { mode: 'hybrid', embeddingAssetId: 'embedding', rerankerAssetId: 'reranker', generatorAssetId: 'generator' },
    },
    retrievalPreference: 'vec-only',
  })
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  await dependencies.manager.setRetrievalPreference('hybrid')

  expect(dependencies.service.calls).toContainEqual(['delete-index', 'col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'indexing' } })
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false)
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'ready_hybrid' } })
})

test('does not restore QMD when an existing index has no verified model', async () => {
  const dependencies = fakeDependencies({ present: false })
  dependencies.service.addReadyCollection()

  await dependencies.manager.restoreExistingIndexes()

  expect(dependencies.events).not.toContain('qmd.start')
  expect(dependencies.events).not.toContain('model.ensure')
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'needs_consent' } })
})

test('requires explicit consent, then prepares the model and QMD before indexing', async () => {
  const { manager, service, events } = fakeDependencies()
  await manager.addCollection('/private/notes')
  const id = 'col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  await expect(manager.reindex(id, false)).rejects.toThrow('confirmation')
  await manager.reindex(id, true)

  expect(events).toEqual(['model.ensure', 'qmd.start', 'qmd.initialize', 'qmd.status', 'qmd.status', 'qmd.query', 'qmd.health'])
  expect(service.calls.map((call) => call[0])).toContain('set-client')
  expect(service.calls.at(-1)[0]).toBe('reindex')
  await expect(manager.snapshot()).resolves.toMatchObject({ state: { name: 'ready_vec' } })
  await expect(manager.modelStatus()).resolves.toMatchObject({ state: 'ready', downloadBytes: 100, diskBytes: 100 })
})

test('cancels an active model preparation without starting QMD', async () => {
  const { manager, events } = fakeDependencies()
  await manager.addCollection('/private/notes')
  manager.cancel()
  expect(events).toContain('model.cancel')
})

test('rejects a concurrent mutation with a stable operation_in_progress code before checking consent', async () => {
  const dependencies = fakeDependencies({ holdEnsure: true })
  await dependencies.manager.addCollection('/private/notes')
  const first = dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  while (!dependencies.events.includes('model.ensure')) await new Promise((resolve) => setTimeout(resolve, 0))

  await expect(dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false))
    .rejects.toMatchObject({ code: 'operation_in_progress' })

  dependencies.modelStore.release()
  await first
})

test('retries a failed QMD startup with 1s, 2s, and 4s backoff', async () => {
  const { manager, events } = fakeDependencies({ failStarts: 3 })
  await manager.addCollection('/private/notes')
  await manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  expect(events).toEqual([
    'model.ensure',
    'qmd.start', 'sleep:1000',
    'qmd.start', 'sleep:2000',
    'qmd.start', 'sleep:4000',
    'qmd.start', 'qmd.initialize', 'qmd.status', 'qmd.status', 'qmd.query', 'qmd.health',
  ])
  await expect(manager.snapshot()).resolves.toMatchObject({ state: { name: 'ready_vec' } })
})

test('restarts an existing QMD runtime when its endpoint becomes unhealthy', async () => {
  const dependencies = fakeDependencies()
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.setQmdHealthy(false)
  dependencies.events.length = 0

  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  expect(dependencies.events).toContain('qmd.health')
  expect(dependencies.events).toContain('qmd.stop')
  expect(dependencies.events).toContain('qmd.start')
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'ready_vec' } })
})

test('reports model verification failure as failed without starting QMD', async () => {
  const { manager, events } = fakeDependencies({ failEnsure: true })
  await manager.addCollection('/private/notes')

  await expect(manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)).rejects.toThrow('checksum')
  await expect(manager.snapshot()).resolves.toMatchObject({ state: { name: 'failed' } })
  expect(events).toEqual(['model.ensure'])
})

test('publishes only public snapshots and forwards model download progress', async () => {
  const dependencies = fakeDependencies({ holdEnsure: true })
  await dependencies.manager.addCollection('/private/notes')
  const updates = []
  const unsubscribe = dependencies.manager.subscribe((snapshot) => updates.push(snapshot))
  const pending = dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  while (!dependencies.events.includes('model.ensure')) await new Promise((resolve) => setTimeout(resolve, 0))
  dependencies.modelStore.emitProgress({ assetId: 'embedding', completed: 42, total: 100 })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(updates.at(-1)).toMatchObject({
    model: { state: 'downloading', completedBytes: 42, downloadBytes: 100 },
  })
  expect(JSON.stringify(updates.at(-1))).not.toContain('qmdDocid')
  expect(Object.keys(updates.at(-1).collections[0])).toEqual([
    'collectionId', 'displayName', 'directory', 'indexState', 'lastIndexedAt',
  ])
  dependencies.modelStore.release()
  await pending
  unsubscribe()
})

test('includes the sanitized runtime reason in public snapshots', async () => {
  const dependencies = fakeDependencies({ failEnsure: true })
  await dependencies.manager.addCollection('/private/notes')
  const updates = []
  const unsubscribe = dependencies.manager.subscribe((snapshot) => updates.push(snapshot))

  await expect(dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)).rejects.toThrow('checksum')
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(updates.at(-1)).toMatchObject({ state: 'failed', reason: 'Knowledge preparation failed' })
  unsubscribe()
})

test('reinitializes the QMD generation after an unexpected daemon exit', async () => {
  const dependencies = fakeDependencies()
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.events.length = 0

  dependencies.crash()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(dependencies.events).toContain('qmd.reset')
  expect(dependencies.events).toContain('qmd.stop')
  expect(dependencies.events).toContain('qmd.start')
  expect(dependencies.events).toContain('qmd.initialize')
  expect(dependencies.events).toContain('qmd.query')
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'ready_vec' } })
})

test('stops recovery after the bounded startup attempts and leaves the runtime degraded', async () => {
  const dependencies = fakeDependencies()
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.events.length = 0

  dependencies.failNextStarts(4)
  dependencies.crash()
  for (let attempt = 0; attempt < 10 && dependencies.events.filter((event) => event === 'qmd.start').length < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  expect(dependencies.events.filter((event) => event === 'qmd.start')).toHaveLength(4)
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'degraded' } })
})

test('watchdog schedules the same recovery when health fails without a child exit event', async () => {
  const dependencies = fakeDependencies({ watchdogIntervalMs: 1 })
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.events.length = 0
  dependencies.setQmdHealthy(false)

  for (let attempt = 0; attempt < 10 && !dependencies.events.includes('qmd.initialize'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }

  expect(dependencies.events).toContain('qmd.stop')
  expect(dependencies.events).toContain('qmd.initialize')
  await dependencies.manager.stop()
})

test('keeps indexing state until every configured collection is ready', async () => {
  const dependencies = fakeDependencies()
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.service.addPendingCollection()

  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'indexing' } })
})

test('keeps the runtime ready when removing one of multiple ready collections', async () => {
  const dependencies = fakeDependencies()
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.service.addReadyCollection()

  await dependencies.manager.removeCollection('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'ready_vec' } })
})

test('ignores disabled collections when deciding whether the runtime is ready', async () => {
  const dependencies = fakeDependencies()
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.service.addDisabledPendingCollection()

  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)

  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'ready_vec' } })
})

test('reports QMD failure as degraded even when the model was already installed', async () => {
  const dependencies = fakeDependencies({ present: true, failInitialize: true })
  await dependencies.manager.addCollection('/private/notes')

  await expect(dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)).rejects.toThrow('preparation failed')

  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'degraded' } })
})

test('clears QMD bindings and stops the daemon when MCP initialization fails', async () => {
  const dependencies = fakeDependencies({ failInitialize: true })
  await dependencies.manager.addCollection('/private/notes')

  await expect(dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)).rejects.toThrow('preparation failed')

  expect(dependencies.events).toContain('qmd.reset')
  expect(dependencies.events).toContain('qmd.stop')
  expect(dependencies.service.calls).toContainEqual(['set-client', undefined])
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'degraded' } })
})

test('recovery remains indexing when a second collection is not ready', async () => {
  const dependencies = fakeDependencies()
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.service.addPendingCollection()
  dependencies.events.length = 0

  dependencies.crash()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(dependencies.events).toContain('qmd.status')
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'indexing' } })
})

test('does not start QMD when the only configured collection is disabled', async () => {
  const dependencies = fakeDependencies()
  dependencies.service.addDisabledPendingCollection()

  await dependencies.manager.restoreExistingIndexes()

  expect(dependencies.events).not.toContain('qmd.start')
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'no_collection' } })
})

test('does not retry a disabled collection', async () => {
  const dependencies = fakeDependencies()
  dependencies.service.addDisabledPendingCollection()

  await dependencies.manager.retry()

  expect(dependencies.events).not.toContain('model.ensure')
  expect(dependencies.events).not.toContain('qmd.start')
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'no_collection' } })
})

test('does not restart QMD after a crash when every collection is disabled', async () => {
  const dependencies = fakeDependencies()
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.service.disableAllCollections()
  dependencies.events.length = 0

  dependencies.crash()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(dependencies.events.filter((event) => event === 'qmd.start')).toHaveLength(0)
  await expect(dependencies.manager.snapshot()).resolves.toMatchObject({ state: { name: 'no_collection' } })
})

test('cleans up RuntimeManager state even when stopping QMD fails', async () => {
  const dependencies = fakeDependencies({ failStop: true, trackProxy: true })
  await dependencies.manager.addCollection('/private/notes')
  await dependencies.manager.reindex('col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true)
  dependencies.events.length = 0

  await expect(dependencies.manager.stop()).resolves.toBeUndefined()

  expect(dependencies.events).toContain('qmd.reset')
  expect(dependencies.events).toContain('proxy.invalidate')
  expect(dependencies.service.calls).toContainEqual(['set-client', undefined])
})


test('memory embeddings start the QMD daemon without a collection', async () => {
  const dependencies = fakeDependencies({ present: true, memoryEnabled: true })

  const status = await dependencies.manager.ensureMemoryEmbeddings()

  expect(status).toEqual({ ok: true, baseUrl: 'http://[::1]:4123' })
  expect(dependencies.events).toContain('qmd.start')
})

test('memory embeddings never download the model and fail closed when it is missing', async () => {
  const dependencies = fakeDependencies({ present: false, memoryEnabled: true })

  const status = await dependencies.manager.ensureMemoryEmbeddings()

  expect(status.ok).toBe(false)
  expect(status.reason).toMatch(/not installed/)
  expect(dependencies.events).not.toContain('qmd.start')
  expect(dependencies.events).not.toContain('model.ensure')
})

test('memory embeddings are skipped while memory is disabled', async () => {
  const dependencies = fakeDependencies({ present: true, memoryEnabled: false })

  const status = await dependencies.manager.ensureMemoryEmbeddings()

  expect(status).toEqual({ ok: false, reason: 'memory is disabled' })
  expect(dependencies.events).not.toContain('qmd.start')
})

test('disabling memory stops a daemon that no collection needs', async () => {
  const dependencies = fakeDependencies({ present: true, memoryEnabled: true })
  await dependencies.manager.ensureMemoryEmbeddings()
  dependencies.events.length = 0

  dependencies.manager.setMemoryEnabled(false)
  const status = await dependencies.manager.ensureMemoryEmbeddings()

  expect(status.ok).toBe(false)
  expect(dependencies.events).toContain('qmd.stop')
})
