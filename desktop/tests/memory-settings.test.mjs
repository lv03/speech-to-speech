import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const { DEFAULT_SETTINGS, SettingsStore } = await import('../src/main/settings')
const { buildVoiceEnvironment } = await import('../src/main/voice-process')

test('memory is off by default and never leaks into argv', async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2s-memory-settings-'))
  const settings = new SettingsStore(join(directory, 'settings.json'))

  expect(settings.get().memoryEnabled).toBe(false)
  expect(settings.get().memoryCloudConsent).toBe(false)

  const env = buildVoiceEnvironment({ baseEnv: {}, gatewayUrl: 'http://127.0.0.1:3101' })
  expect(env.S2S_MEMORY_BACKEND).toBeUndefined()
  expect(env.S2S_MEMORY_SIDECAR_PYTHON).toBeUndefined()
})

test('memory env is injected only when enabled and consented', () => {
  const options = {
    baseEnv: {},
    gatewayUrl: 'http://127.0.0.1:3101',
    memorySidecarPython: '/opt/voicemem/bin/python',
    memorySidecarScript: '/opt/sidecar.py',
    memoryRoot: '/tmp/app-memory',
    memoryExtractionBaseUrl: 'https://api.deepseek.com',
    memoryExtractionModel: 'deepseek-v4-flash',
    memoryEmbedderBaseUrl: 'http://[::1]:4123',
    memoryMaxChars: 900,
  }

  const enabledOnly = buildVoiceEnvironment({ ...options, memoryEnabled: true, memoryCloudConsent: false })
  expect(enabledOnly.S2S_MEMORY_BACKEND).toBeUndefined()

  const consentedOnly = buildVoiceEnvironment({ ...options, memoryEnabled: false, memoryCloudConsent: true })
  expect(consentedOnly.S2S_MEMORY_BACKEND).toBeUndefined()

  const both = buildVoiceEnvironment({ ...options, memoryEnabled: true, memoryCloudConsent: true })
  expect(both.S2S_MEMORY_BACKEND).toBe('voicemem')
  expect(both.S2S_MEMORY_SIDECAR_PYTHON).toBe('/opt/voicemem/bin/python')
  expect(both.S2S_MEMORY_SIDECAR_SCRIPT).toBe('/opt/sidecar.py')
  expect(both.S2S_MEMORY_ROOT).toBe('/tmp/app-memory')
  expect(both.S2S_MEMORY_BASE_URL).toBe('https://api.deepseek.com')
  // Embeddings always come from the QMD daemon; the backend name is always set
  // so the sidecar never silently falls back to another model.
  expect(both.S2S_MEMORY_EMBEDDER).toBe('qmd')
  expect(both.S2S_MEMORY_EMBEDDER_BASE_URL).toBe('http://[::1]:4123')
  expect(both.S2S_MEMORY_MODEL).toBe('deepseek-v4-flash')
  expect(both.S2S_MEMORY_MAX_CHARS).toBe('900')
  // mem0's vector backend is pinned to SQLite/sqlite-vec, not a user setting.
  expect(both.S2S_MEMORY_VECTOR_STORE).toBe('sqlite_vec')
})

test('memory env from the parent environment is cleared when memory is off', () => {
  const env = buildVoiceEnvironment({
    baseEnv: {
      S2S_MEMORY_BACKEND: 'voicemem',
      S2S_MEMORY_SIDECAR_PYTHON: '/stale/python',
      S2S_MEMORY_ROOT: '/stale/root',
      S2S_MEMORY_BASE_URL: 'https://stale.example.com',
      S2S_MEMORY_EMBEDDER: 'local',
      S2S_MEMORY_EMBEDDER_BASE_URL: 'http://[::1]:9999',
      S2S_MEMORY_VECTOR_STORE: 'qdrant',
    },
    gatewayUrl: 'http://127.0.0.1:3101',
  })

  expect(env.S2S_MEMORY_BACKEND).toBeUndefined()
  expect(env.S2S_MEMORY_SIDECAR_PYTHON).toBeUndefined()
  expect(env.S2S_MEMORY_ROOT).toBeUndefined()
  expect(env.S2S_MEMORY_BASE_URL).toBeUndefined()
  expect(env.S2S_MEMORY_EMBEDDER).toBeUndefined()
  expect(env.S2S_MEMORY_EMBEDDER_BASE_URL).toBeUndefined()
  expect(env.S2S_MEMORY_VECTOR_STORE).toBeUndefined()
})

test('settings round-trip the memory fields and reject out-of-range limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2s-memory-settings-'))
  const path = join(directory, 'settings.json')
  const settings = new SettingsStore(path)

  settings.save({
    memoryEnabled: true,
    memoryCloudConsent: true,
    memorySidecarPython: '  /opt/voicemem/bin/python  ',
    memorySidecarScript: '/opt/sidecar.py',
    memoryExtractionBaseUrl: '  http://127.0.0.1:8080/v1  ',
    memoryExtractionModel: 'qwen3-8b',
    memoryMaxChars: 900,
  })

  expect(settings.get()).toMatchObject({
    memoryEnabled: true,
    memoryCloudConsent: true,
    memorySidecarPython: '/opt/voicemem/bin/python',
    memorySidecarScript: '/opt/sidecar.py',
    memoryExtractionBaseUrl: 'http://127.0.0.1:8080/v1',
    memoryExtractionModel: 'qwen3-8b',
    memoryMaxChars: 900,
  })

  await writeFile(path, JSON.stringify({ memoryMaxChars: 99 }))
  const reloaded = new SettingsStore(path)
  expect(reloaded.get().memoryMaxChars).toBe(DEFAULT_SETTINGS.memoryMaxChars)
})
