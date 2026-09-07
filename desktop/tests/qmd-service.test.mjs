import { chmod, mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { QmdService } from '../src/main/qmd-service'

function runner(calls = []) {
  return {
    add: async (...args) => { calls.push(['add', ...args]) },
    remove: async (...args) => { calls.push(['remove', ...args]) },
    reindex: async (...args) => { calls.push(['reindex', ...args]) },
    deleteIndex: async (...args) => { calls.push(['delete-index', ...args]) },
  }
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 's2s-qmd-service-'))
  const notes = join(root, 'notes')
  const metadataPath = join(root, 'collections.json')
  await mkdir(notes)
  await writeFile(join(notes, 'safe.md'), '# safe\n')
  const calls = []
  const clientCalls = []
  const client = options.client ?? {
    initialize: async () => ({ version: '2.8.3' }),
    query: async (...args) => {
      clientCalls.push(['query', ...args])
      return [{ docid: '#internal-docid', file: 'safe.md', title: 'Safe', score: 0.81, snippet: 'hit', line: 1 }]
    },
    get: async (...args) => {
      clientCalls.push(['get', ...args])
      return 'trusted content'
    },
    status: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
  }
  const service = new QmdService({
    metadataPath,
    runner: options.runner ?? runner(calls),
    client,
    now: options.now,
    handleTtlMs: options.handleTtlMs,
    maxHandles: options.maxHandles,
  })
  return { root, notes, metadataPath, calls, clientCalls, service }
}

test('canonicalizes roots, rejects duplicate directories, and rebuilds a deleted index without deleting sources', async () => {
  const { root, notes, metadataPath, calls, service } = await fixture()
  const alias = join(root, 'notes-alias')
  await symlink(notes, alias)

  const collection = await service.addCollection(notes, 'My notes')
  expect(collection.root).toBe(await realpath(notes))
  expect(collection.collectionId).toMatch(/^col_[a-f0-9]{32}$/)
  await expect(service.addCollection(alias, 'Duplicate')).rejects.toMatchObject({ code: 'collection_exists' })

  await service.deleteIndex(collection.collectionId)
  expect((await service.snapshot()).collections[0]).toMatchObject({ indexState: 'pending', lastIndexedAt: null })
  expect(JSON.parse(await readFile(metadataPath, 'utf8'))[0].qmdConfigured).toBe(false)
  await service.reindex(collection.collectionId)

  expect(calls.map((call) => call[0])).toEqual(['add', 'reindex'])
  expect(JSON.parse(await readFile(metadataPath, 'utf8'))[0].qmdConfigured).toBe(true)
  expect((await service.snapshot()).collections[0].indexState).toBe('ready')
  await expect(readFile(join(notes, 'safe.md'), 'utf8')).resolves.toBe('# safe\n')
})

test('adding a collection only persists metadata and does not touch QMD', async () => {
  const { notes, calls, service, metadataPath } = await fixture()

  const collection = await service.addCollection(notes, 'Pending notes')

  expect(collection.indexState).toBe('pending')
  expect(calls).toEqual([])
  expect(JSON.parse(await readFile(metadataPath, 'utf8'))[0].qmdConfigured).toBe(false)
})

test('invalidates ready indexes when the retrieval fingerprint changes', async () => {
  const { notes, service } = await fixture()
  service.setIndexFingerprint('f'.repeat(64))
  const collection = await service.addCollection(notes, 'Fingerprint notes')
  await service.reindex(collection.collectionId)

  await expect(service.snapshot()).resolves.toMatchObject({
    collections: [{ indexState: 'ready', indexFingerprint: 'f'.repeat(64) }],
  })

  service.setIndexFingerprint('e'.repeat(64))

  await expect(service.snapshot()).resolves.toMatchObject({
    state: { name: 'indexing' },
    collections: [{ indexState: 'pending', indexFingerprint: null, lastIndexedAt: null }],
  })
  await expect(service.search('query', collection.collectionId)).rejects.toMatchObject({ code: 'knowledge_indexing' })
})

test('does not deadlock when a fingerprint changes after reindex is queued', async () => {
  const { notes, service } = await fixture()
  service.setIndexFingerprint('f'.repeat(64))
  await service.snapshot()
  const collection = await service.addCollection(notes, 'Concurrent fingerprint notes')

  const reindex = service.reindex(collection.collectionId)
  service.setIndexFingerprint('e'.repeat(64))

  const result = await Promise.race([
    reindex.then(() => 'done'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
  ])
  expect(result).toBe('done')
})

test('rejects adding a thirty-third enabled collection with a stable limit error', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-qmd-service-limit-'))
  const service = new QmdService({ metadataPath: join(root, 'collections.json'), runner: runner() })

  for (let index = 0; index < 32; index += 1) {
    const collectionRoot = join(root, `notes-${index}`)
    await mkdir(collectionRoot)
    await service.addCollection(collectionRoot)
  }
  const overflowRoot = join(root, 'notes-overflow')
  await mkdir(overflowRoot)

  await expect(service.addCollection(overflowRoot)).rejects.toMatchObject({
    code: 'collection_limit',
    message: 'The maximum number of enabled knowledge collections is 32',
  })
})

test('rejects dot-segment collection names', async () => {
  const { notes, service } = await fixture()
  await expect(service.addCollection(notes, '.')).rejects.toMatchObject({ code: 'collection_invalid' })
  await expect(service.addCollection(notes, '..')).rejects.toMatchObject({ code: 'collection_invalid' })
})

test('uses a single-writer queue for collection mutations', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-qmd-queue-'))
  const firstRoot = join(root, 'first')
  const secondRoot = join(root, 'second')
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
  let active = 0
  let maximumActive = 0
  const service = new QmdService({
    metadataPath: join(root, 'collections.json'),
    runner: {
      ...runner(),
      reindex: async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
      },
    },
  })

  const collections = await Promise.all([
    service.addCollection(firstRoot),
    service.addCollection(secondRoot),
  ])
  await Promise.all(collections.map((collection) => service.reindex(collection.collectionId)))

  expect(maximumActive).toBe(1)
})

test('issues opaque docids, rejects unsafe result paths, and sends only the mapped QMD docid to get', async () => {
  const outsideRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-outside-'))
  const outsideFile = join(outsideRoot, 'outside.md')
  await writeFile(outsideFile, 'outside')
  const clientCalls = []
  const client = {
    initialize: async () => ({ version: '2.8.3' }),
    query: async (...args) => {
      clientCalls.push(['query', ...args])
      return [
        { docid: '#internal-docid', file: 'safe.md', title: 'Safe', score: 0.9, snippet: 'good' },
        { docid: '#traversal', file: '../outside.md', title: 'Bad', score: 0.8, snippet: 'bad' },
        { docid: '#nul', file: 'safe.md\0outside', title: 'Bad', score: 0.7, snippet: 'bad' },
        { docid: '#absolute', file: outsideFile, title: 'Bad', score: 0.6, snippet: 'bad' },
        { docid: '#symlink', file: 'escape.md', title: 'Bad', score: 0.5, snippet: 'bad' },
      ]
    },
    get: async (...args) => {
      clientCalls.push(['get', ...args])
      return 'trusted content'
    },
    status: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
  }
  const { notes, service } = await fixture({ client })
  await symlink(outsideFile, join(notes, 'escape.md'))
  const collection = await service.addCollection(notes, 'Notes')
  await service.reindex(collection.collectionId)

  const hits = await service.search('safe', collection.collectionId, 5)

  expect(hits).toEqual([expect.objectContaining({
    docid: expect.stringMatching(/^doc_[a-f0-9]{64}$/),
    collectionId: collection.collectionId,
    collectionName: 'Notes',
    relativeFile: 'safe.md',
  })])
  expect(hits[0]).not.toHaveProperty('qmdDocid')
  expect(JSON.stringify(hits)).not.toContain(notes)
  await expect(service.getDocument(hits[0].docid, { startLine: 2, endLine: 4 })).resolves.toEqual({
    docid: hits[0].docid,
    collectionName: 'Notes',
    relativeFile: 'safe.md',
    title: 'Safe',
    content: 'trusted content',
  })
  expect(clientCalls).toContainEqual(['query', 'safe', `kb_${collection.collectionId}`, 5])
  expect(clientCalls).toContainEqual(['get', '#internal-docid', 2, 3])

  service.setClient(undefined)
  await expect(service.getDocument(hits[0].docid, { startLine: 1, endLine: 1 }))
    .rejects.toMatchObject({ code: 'document_not_allowed' })
})

test('accepts QMD structured-search files prefixed with the internal collection name', async () => {
  const clientCalls = []
  const client = {
    initialize: async () => ({ version: '2.8.3' }),
    query: async (...args) => {
      clientCalls.push(['query', ...args])
      return [{
        docid: '#qmd-docid',
        file: `${args[1]}/allergy.md`,
        title: 'Allergy',
        score: 1,
        snippet: 'peanut allergy',
      }]
    },
    get: async (...args) => {
      clientCalls.push(['get', ...args])
      return '# Allergy\n'
    },
    status: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
  }
  const { notes, service } = await fixture({ client })
  await writeFile(join(notes, 'allergy.md'), '# Allergy\n')
  const collection = await service.addCollection(notes)
  await service.reindex(collection.collectionId)

  const results = await service.search('peanut allergy', collection.collectionId, 3)

  expect(results).toHaveLength(1)
  expect(results[0].relativeFile).toBe('allergy.md')
})

test('rejects decoded qmd paths containing separators even when the filename exists', async () => {
  const { notes, service } = await fixture({
    client: {
      initialize: async () => ({ version: '2.8.3' }),
      query: async (_query, collectionName) => [{
        docid: '#encoded-backslash',
        file: `qmd://${collectionName}/%5Coutside.md`,
        title: 'Bad',
        score: 1,
        snippet: 'bad',
      }],
      get: async () => 'bad',
      status: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    },
  })
  await writeFile(join(notes, '\\outside.md'), 'outside')
  const collection = await service.addCollection(notes, 'Notes')
  await service.reindex(collection.collectionId)

  await expect(service.search('bad', collection.collectionId, 5)).resolves.toEqual([])
})

test('rejects no collection, indexing, daemon failure, and unknown or expired docids', async () => {
  let now = 1_000
  const { notes, service } = await fixture({ now: () => new Date(now), handleTtlMs: 10 })
  await expect(service.search('query')).rejects.toMatchObject({ code: 'no_collection' })

  const collection = await service.addCollection(notes)
  await expect(service.search('query')).rejects.toMatchObject({ code: 'knowledge_indexing' })
  await service.reindex(collection.collectionId)
  const [hit] = await service.search('query')

  await expect(service.getDocument('doc_' + '0'.repeat(64), { startLine: 1, endLine: 1 }))
    .rejects.toMatchObject({ code: 'document_not_allowed' })
  now += 11
  await expect(service.getDocument(hit.docid, { startLine: 1, endLine: 1 }))
    .rejects.toMatchObject({ code: 'document_not_allowed' })

  const unavailable = await fixture({
    client: {
      initialize: async () => ({ version: '2.8.3' }),
      query: async () => { throw new Error('/private/qmd socket failed') },
      get: async () => '',
      status: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    },
  })
  const unavailableCollection = await unavailable.service.addCollection(unavailable.notes)
  await unavailable.service.reindex(unavailableCollection.collectionId)
  await expect(unavailable.service.search('query')).rejects.toMatchObject({
    code: 'proxy_unavailable',
    message: 'Knowledge service is unavailable',
  })
})

test('evicts the oldest docid when the bounded docid store is full', async () => {
  let sequence = 0
  const { notes, service } = await fixture({
    maxHandles: 1,
    client: {
      initialize: async () => ({ version: '2.8.3' }),
      query: async () => [{ docid: `#internal-${++sequence}`, file: 'safe.md', title: 'Safe', score: 1, snippet: '' }],
      get: async () => 'content',
      status: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    },
  })
  const collection = await service.addCollection(notes)
  await service.reindex(collection.collectionId)
  const [first] = await service.search('first')
  const [second] = await service.search('second')

  await expect(service.getDocument(first.docid, { startLine: 1, endLine: 1 }))
    .rejects.toMatchObject({ code: 'document_not_allowed' })
  await expect(service.getDocument(second.docid, { startLine: 1, endLine: 1 })).resolves.toMatchObject({
    docid: second.docid,
  })
})

test('preserves RuntimeManager availability state when taking a snapshot', async () => {
  const { notes, service } = await fixture()
  await service.addCollection(notes)
  service.setRuntimeState({ name: 'degraded', reason: 'QMD daemon stopped', updatedAt: '2026-09-05T00:00:00.000Z' })

  await expect(service.snapshot()).resolves.toMatchObject({
    state: { name: 'degraded', reason: 'QMD daemon stopped' },
  })
})

test('restores persisted QMD collection configuration without adding it again', async () => {
  const first = await fixture()
  const collection = await first.service.addCollection(first.notes, 'Notes')
  await first.service.reindex(collection.collectionId)

  const calls = []
  const reloaded = new QmdService({
    metadataPath: first.metadataPath,
    runner: runner(calls),
    client: {
      initialize: async () => ({ version: '2.8.3' }),
      query: async () => [],
      get: async () => '',
      status: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    },
  })

  await reloaded.reindex(collection.collectionId)

  expect(calls.map((call) => call[0])).toEqual(['reindex'])
})

test('repairs permissions on the persisted metadata directory and file', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-qmd-metadata-permissions-'))
  const notes = join(root, 'notes')
  const metadataDirectory = join(root, 'knowledge')
  const metadataPath = join(metadataDirectory, 'collections.json')
  await mkdir(notes)
  await mkdir(metadataDirectory, { mode: 0o755 })
  await writeFile(metadataPath, '[]\n', { mode: 0o644 })
  const service = new QmdService({ metadataPath, runner: runner() })

  await service.addCollection(notes)

  expect((await stat(metadataDirectory)).mode & 0o777).toBe(0o700)
  expect((await stat(metadataPath)).mode & 0o777).toBe(0o600)
})

test('repairs persisted metadata permissions during read-only startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-qmd-metadata-load-permissions-'))
  const metadataDirectory = join(root, 'knowledge')
  const metadataPath = join(metadataDirectory, 'collections.json')
  await mkdir(metadataDirectory, { mode: 0o755 })
  await writeFile(metadataPath, '[]\n', { mode: 0o644 })

  const service = new QmdService({ metadataPath, runner: runner() })
  await service.snapshot()

  expect((await stat(metadataDirectory)).mode & 0o777).toBe(0o700)
  expect((await stat(metadataPath)).mode & 0o777).toBe(0o600)
})

test('exposes a public docid contract and accepts that docid for document reads', async () => {
  const { notes, service } = await fixture({
    client: {
      initialize: async () => ({ version: '2.8.3' }),
      query: async () => [{ docid: '#internal-docid', file: 'safe.md', title: 'Safe', score: 1, snippet: 'safe' }],
      get: async (docid) => `content for ${docid}`,
      status: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    },
  })
  const collection = await service.addCollection(notes)
  await service.reindex(collection.collectionId)

  const [hit] = await service.search('safe')
  expect(hit).toHaveProperty('docid')
  expect(hit).not.toHaveProperty('handle')
  expect(hit.docid).toMatch(/^doc_[a-f0-9]{64}$/)

  await expect(service.getDocument(hit.docid, { startLine: 1, endLine: 1 })).resolves.toMatchObject({
    docid: hit.docid,
    content: 'content for #internal-docid',
  })
})
