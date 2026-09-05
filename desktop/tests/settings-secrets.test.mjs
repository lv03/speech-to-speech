import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

const encrypted = new Map()

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
  },
}))

const { SettingsStore } = await import('../src/main/settings')
const { SecretStore } = await import('../src/main/secret-store')

test('migrates a legacy plaintext key into encrypted storage without returning or persisting it publicly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2s-settings-secret-'))
  const settingsPath = join(directory, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ llmApiKey: 'sk-legacy-secret', llmModel: 'test-model' }))

  const settings = new SettingsStore(settingsPath)
  const secrets = new SecretStore(join(directory, 'secrets.json'))
  settings.migrateLegacyLlmApiKey(secrets)

  expect(settings.get()).toMatchObject({ llmModel: 'test-model' })
  expect(settings.get()).not.toHaveProperty('llmApiKey')
  expect(secrets.hasLlmApiKey()).toBe(true)
  expect(secrets.getLlmApiKey()).toBe('sk-legacy-secret')
  expect(await readFile(settingsPath, 'utf8')).not.toContain('sk-legacy-secret')
  expect(await readFile(join(directory, 'secrets.json'), 'utf8')).not.toContain('sk-legacy-secret')
})

test('ignores renderer attempts to persist an API key in public settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2s-settings-public-'))
  const settings = new SettingsStore(join(directory, 'settings.json'))

  const saved = settings.save({ llmApiKey: 'renderer-secret', llmModel: 'safe-model' })

  expect(saved).toMatchObject({ llmModel: 'safe-model' })
  expect(saved).not.toHaveProperty('llmApiKey')
  expect(await readFile(join(directory, 'settings.json'), 'utf8')).not.toContain('renderer-secret')
})
