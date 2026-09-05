import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
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
    metadataPath: join(root, 'collections.json'),
    runner: options.runner ?? runner(calls),
    client,
    now: options.now,
    handleTtlMs: options.handleTtlMs,
    maxHandles: options.maxHandles,
  })
  return { root, notes, calls, clientCalls, service }
}

test('canonicalizes roots, rejects duplicate directories, and rebuilds a deleted index without deleting sources', async () => {
  const { root, notes, calls, service } = await fixture()
  const alias = join(root, 'notes-alias')
  await symlink(notes, alias)

  const first = await service.addCollection(notes, 'My notes')
  expect(first.root).toBe(await realpath(notes))
  expect(first.collectionId).toMatch(/^col_[a-f0-9]{32}$/)
  await expect(service.addCollection(alias, 'Duplicate')).rejects.toMatchObject({ code: 'collection_exists' })

  await service.deleteIndex(first.collectionId)
  expect((await service.snapshot()).collections[0]).toMatchObject({ indexState: 'pending', lastIndexedAt: null })
  await service.reindex(first.collectionId)

  expect(calls.map((call) => call[0])).toEqual(['add', 'delete-index', 'add', 'reindex'])
  expect((await service.snapshot()).collections[0].indexState).toBe('ready')
  await expect(readFile(join(notes, 'safe.md'), 'utf8')).resolves.toBe('# safe\n')
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
      add: async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
      },
    },
  })

  await Promise.all([
    service.addCollection(firstRoot),
    service.addCollection(secondRoot),
  ])

  expect(maximumActive).toBe(1)
})

test('issues opaque handles, rejects unsafe result paths, and sends only the mapped QMD docid to get', async () => {
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
    handle: expect.stringMatching(/^doc_[a-f0-9]{64}$/),
    collectionId: collection.collectionId,
    collectionName: 'Notes',
    relativeFile: 'safe.md',
  })])
  expect(hits[0]).not.toHaveProperty('qmdDocid')
  expect(JSON.stringify(hits)).not.toContain(notes)
  await expect(service.getDocument(hits[0].handle, { startLine: 2, endLine: 4 })).resolves.toEqual({
    handle: hits[0].handle,
    collectionName: 'Notes',
    relativeFile: 'safe.md',
    title: 'Safe',
    content: 'trusted content',
  })
  expect(clientCalls).toContainEqual(['query', 'safe', `kb_${collection.collectionId}`, 5])
  expect(clientCalls).toContainEqual(['get', '#internal-docid', 2, 3])
})

test('rejects no collection, indexing, daemon failure, and unknown or expired handles', async () => {
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
  await expect(service.getDocument(hit.handle, { startLine: 1, endLine: 1 }))
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

test('evicts the oldest handle when the bounded handle store is full', async () => {
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

  await expect(service.getDocument(first.handle, { startLine: 1, endLine: 1 }))
    .rejects.toMatchObject({ code: 'document_not_allowed' })
  await expect(service.getDocument(second.handle, { startLine: 1, endLine: 1 })).resolves.toMatchObject({
    handle: second.handle,
  })
})
