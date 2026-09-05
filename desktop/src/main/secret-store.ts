import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

interface EncryptedSecrets {
  llmApiKey?: string
}

function readSecrets(path: string): EncryptedSecrets {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const key = (value as Record<string, unknown>).llmApiKey
      return typeof key === 'string' ? { llmApiKey: key } : {}
    }
  } catch {
    // A missing or corrupt secret file is treated as empty.
  }
  return {}
}

/** Persists only Electron safeStorage ciphertext, never plaintext credentials. */
export class SecretStore {
  private readonly path: string
  private secrets: EncryptedSecrets

  constructor(path: string) {
    this.path = path
    this.secrets = readSecrets(path)
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  hasLlmApiKey(): boolean {
    return Boolean(this.secrets.llmApiKey)
  }

  getLlmApiKey(): string {
    if (!this.secrets.llmApiKey || !this.isAvailable()) return ''
    try {
      return safeStorage.decryptString(Buffer.from(this.secrets.llmApiKey, 'base64'))
    } catch {
      return ''
    }
  }

  setLlmApiKey(value: unknown): void {
    if (typeof value !== 'string' || !value.trim()) throw new Error('API key is required')
    if (!this.isAvailable()) throw new Error('Secure credential storage is unavailable')
    this.secrets = { llmApiKey: safeStorage.encryptString(value).toString('base64') }
    this.save()
  }

  clearLlmApiKey(): void {
    this.secrets = {}
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(this.secrets)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.path)
    } finally {
      if (existsSync(temporary)) {
        try { unlinkSync(temporary) } catch { /* best effort */ }
      }
    }
  }
}
