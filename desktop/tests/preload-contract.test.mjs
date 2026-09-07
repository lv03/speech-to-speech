import { expect, test, vi } from 'vitest'

let exposedApi

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name, api) => { exposedApi = api },
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  },
}))

await import('../src/preload/index.ts')

test('exposes one knowledge snapshot subscription method', () => {
  expect(exposedApi).toBeDefined()
  expect(exposedApi).toHaveProperty('onKnowledgeSnapshot')
  expect(exposedApi).not.toHaveProperty('onKnowledgeSnapshotChanged')
})
