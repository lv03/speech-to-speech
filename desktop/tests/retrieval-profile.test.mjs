import { expect, test } from 'vitest'

import { getIndexFingerprint, getRetrievalProfiles } from '../src/main/retrieval-profile'

const assets = [
  { id: 'embedding', version: '1', kind: 'model', role: 'embedding', install: 'userData', url: 'https://downloads.example/embedding', size: 1, sha256: 'a'.repeat(64) },
  { id: 'reranker', version: '1', kind: 'model', role: 'reranker', install: 'userData', url: 'https://downloads.example/reranker', size: 1, sha256: 'b'.repeat(64) },
  { id: 'generator', version: '1', kind: 'model', role: 'generator', install: 'userData', url: 'https://downloads.example/generator', size: 1, sha256: 'c'.repeat(64) },
]

function manifest(approvedProfiles) {
  return {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    approvedProfiles,
    assets,
  }
}

test('does not infer hybrid from model roles when the release did not approve it', () => {
  const profiles = getRetrievalProfiles(manifest(['vec-only']))

  expect(profiles.vecOnly).toMatchObject({ mode: 'vec-only', embeddingAssetId: 'embedding' })
  expect(profiles.hybrid).toBeNull()
})

test('exposes hybrid only when the release explicitly approves it', () => {
  expect(getRetrievalProfiles(manifest(['vec-only', 'hybrid'])).hybrid).toMatchObject({
    mode: 'hybrid',
    embeddingAssetId: 'embedding',
    rerankerAssetId: 'reranker',
    generatorAssetId: 'generator',
  })
})

test('changes the index fingerprint when mode, model version, or QMD version changes', () => {
  const value = manifest(['vec-only', 'hybrid'])
  const profiles = getRetrievalProfiles(value)

  const vecFingerprint = getIndexFingerprint(value, profiles.vecOnly, '2.8.3')
  expect(vecFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(getIndexFingerprint(value, profiles.vecOnly, '2.8.3')).toBe(vecFingerprint)
  expect(getIndexFingerprint(value, profiles.hybrid, '2.8.3')).not.toBe(vecFingerprint)
  expect(getIndexFingerprint(value, profiles.vecOnly, '2.8.4')).not.toBe(vecFingerprint)

  const changed = {
    ...value,
    assets: value.assets.map((asset) => asset.id === 'embedding' ? { ...asset, version: '2' } : asset),
  }
  expect(getIndexFingerprint(changed, getRetrievalProfiles(changed).vecOnly, '2.8.3')).not.toBe(vecFingerprint)
})
