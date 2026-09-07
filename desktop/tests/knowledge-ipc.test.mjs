import { expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise(() => {}),
    on: () => undefined,
  },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => undefined },
  Tray: class {},
  Notification: { isSupported: () => false },
  globalShortcut: { unregisterAll: () => undefined },
  nativeImage: { createFromDataURL: () => ({}) },
  net: { fetch: () => undefined },
  protocol: { handle: () => undefined },
  ipcMain: { handle: () => undefined, on: () => undefined },
  dialog: { showOpenDialog: () => undefined },
}))

const { createKnowledgeIpcHandlers } = await import('../src/main/index')

const COLLECTION_ID = `col_${'a'.repeat(32)}`

test('knowledge IPC picks directories in main, uses collection IDs, and returns only public collection fields', async () => {
  const calls = []
  const handlers = createKnowledgeIpcHandlers({
    service: {
      snapshot: async () => ({
        state: { name: 'ready_vec', reason: '/private/qmd/index.sqlite', updatedAt: '2026-09-05T00:00:00.000Z' },
        collections: [{
          collectionId: COLLECTION_ID,
          displayName: 'Private notes',
          root: '/Users/me/Notes',
          include: '**/*.md',
          enabled: true,
          lastIndexedAt: '2026-09-05T00:00:00.000Z',
          indexState: 'ready',
        }],
      }),
      addCollection: async (directory) => {
        calls.push(['add', directory])
      },
      removeCollection: async (id) => calls.push(['remove', id]),
      reindex: async (id, confirmed) => {
        if (!confirmed) throw new Error('Model download confirmation is required')
        calls.push(['reindex', id, confirmed])
      },
      deleteIndex: async (id) => calls.push(['delete-index', id]),
    },
    pickDirectory: async () => ({ canceled: false, filePaths: ['/Users/me/Notes'] }),
    modelStatus: async () => ({ downloadBytes: 600, diskBytes: 400, state: 'needs_consent' }),
    cancel: () => calls.push(['cancel']),
  })

  const snapshot = await handlers.snapshot()
  expect(snapshot).toEqual({
    state: 'ready_vec',
    model: { downloadBytes: 600, diskBytes: 400, state: 'needs_consent' },
    collections: [{
      collectionId: COLLECTION_ID,
      displayName: 'Private notes',
      directory: '/Users/me/Notes',
      indexState: 'ready',
      lastIndexedAt: '2026-09-05T00:00:00.000Z',
    }],
  })
  expect(JSON.stringify(snapshot)).not.toContain('/private/qmd')
  expect(JSON.stringify(snapshot)).not.toContain('**/*.md')

  await handlers.addCollection()
  await handlers.removeCollection(COLLECTION_ID)
  await expect(handlers.reindex(COLLECTION_ID)).rejects.toThrow('Model download confirmation is required')
  await handlers.reindex(COLLECTION_ID, true)
  await handlers.deleteIndex(COLLECTION_ID)
  handlers.cancel()
  expect(calls).toEqual([
    ['add', '/Users/me/Notes'],
    ['remove', COLLECTION_ID],
    ['reindex', COLLECTION_ID, true],
    ['delete-index', COLLECTION_ID],
    ['cancel'],
  ])
  await expect(handlers.removeCollection('notes; rm -rf /')).rejects.toThrow('Invalid knowledge collection')
})

test('passes consent into the runtime guard without an IPC pre-check race', async () => {
  const calls = []
  let release
  let active = false
  let modelStatusCalls = 0
  const handlers = createKnowledgeIpcHandlers({
    service: {
      snapshot: async () => ({ state: { name: 'indexing', updatedAt: '2026-09-05T00:00:00.000Z' }, collections: [] }),
      addCollection: async () => undefined,
      removeCollection: async () => undefined,
      reindex: async (id, confirmed) => {
        if (active) {
          const error = new Error('Knowledge operation is already running')
          error.code = 'operation_in_progress'
          throw error
        }
        active = true
        calls.push(['reindex', id, confirmed])
        try {
          if (!confirmed) throw new Error('Model download confirmation is required')
          await new Promise((resolve) => { release = resolve })
        } finally {
          active = false
        }
      },
      deleteIndex: async () => undefined,
    },
    pickDirectory: async () => ({ canceled: true, filePaths: [] }),
    modelStatus: async () => {
      modelStatusCalls += 1
      return { downloadBytes: 600, diskBytes: 400, state: 'needs_consent' }
    },
    cancel: () => undefined,
  })

  const first = handlers.reindex(COLLECTION_ID, true)
  while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 0))
  await expect(handlers.reindex(COLLECTION_ID, false)).rejects.toThrow('知识库已有操作正在进行')
  expect(calls).toEqual([['reindex', COLLECTION_ID, true]])
  expect(modelStatusCalls).toBe(0)
  release()
  await first
})
