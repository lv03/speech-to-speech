import { generateKeyPairSync, sign } from 'node:crypto'

import { expect, test } from 'vitest'

import {
  parseAndVerifyRuntimeManifest,
  validateRuntimeManifest,
} from '../src/main/runtime-manifest'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    approvedProfiles: ['vec-only'],
    assets: [
      {
        id: 'python-runtime',
        version: '1.0.0',
        kind: 'python-runtime',
        install: 'resources',
        path: 'runtime/python.tar.gz',
        url: 'https://downloads.example/python.tar.gz',
        size: 12,
        sha256: 'a'.repeat(64),
      },
      {
        id: 'wheelhouse',
        version: '1.0.0',
        kind: 'wheelhouse',
        install: 'resources',
        path: 'runtime/wheelhouse.tar.gz',
        url: 'https://downloads.example/wheelhouse.tar.gz',
        size: 12,
        sha256: 'b'.repeat(64),
      },
      {
        id: 'qmd',
        version: '2.8.3',
        kind: 'qmd',
        install: 'resources',
        path: 'qmd/qmd.tar.gz',
        url: 'https://downloads.example/qmd.tar.gz',
        size: 12,
        sha256: 'c'.repeat(64),
      },
      {
        id: 'embedding',
        version: '1.0.0',
        kind: 'model',
        role: 'embedding',
        install: 'userData',
        url: 'https://downloads.example/embedding.gguf',
        size: 12,
        sha256: 'd'.repeat(64),
      },
    ],
    ...overrides,
  }
}

function signedManifest(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const signature = sign(null, Buffer.from(text), privateKey).toString('base64')
  return { text, signature }
}

test('accepts a signed v1 manifest with an explicitly approved profile', () => {
  const value = manifest()
  const { text, signature } = signedManifest(value)

  expect(parseAndVerifyRuntimeManifest(text, signature, publicKey, { requireSignature: true })).toEqual(value)
})

test('rejects a missing, invalid, or tampered manifest signature', () => {
  const value = manifest()
  const { text, signature } = signedManifest(value)

  expect(() => parseAndVerifyRuntimeManifest(text, undefined, publicKey, { requireSignature: true })).toThrow(/signature/i)
  expect(() => parseAndVerifyRuntimeManifest(text, 'not-base64', publicKey, { requireSignature: true })).toThrow(/signature/i)
  expect(() => parseAndVerifyRuntimeManifest(`${text} `, signature, publicKey, { requireSignature: true })).toThrow(/signature/i)
})

test('requires vec-only approval and does not infer hybrid from model roles', () => {
  expect(() => validateRuntimeManifest(manifest({ approvedProfiles: [] }))).toThrow(/approvedProfiles/i)
  expect(() => validateRuntimeManifest(manifest({
    approvedProfiles: ['hybrid'],
    assets: [
      ...manifest().assets,
      {
        id: 'reranker',
        version: '1.0.0',
        kind: 'model',
        role: 'reranker',
        install: 'userData',
        url: 'https://downloads.example/reranker.gguf',
        size: 12,
        sha256: 'e'.repeat(64),
      },
      {
        id: 'generator',
        version: '1.0.0',
        kind: 'model',
        role: 'generator',
        install: 'userData',
        url: 'https://downloads.example/generator.gguf',
        size: 12,
        sha256: 'f'.repeat(64),
      },
    ],
  }))).toThrow(/vec-only/i)
})

test('rejects unsafe asset URLs and resource paths before provisioning', () => {
  expect(() => validateRuntimeManifest(manifest({
    assets: manifest().assets.map((asset) => asset.id === 'qmd' ? { ...asset, url: 'http://downloads.example/qmd.tar.gz' } : asset),
  }))).toThrow(/https/i)
  expect(() => validateRuntimeManifest(manifest({
    assets: manifest().assets.map((asset) => asset.id === 'qmd' ? { ...asset, path: '../qmd.tar.gz' } : asset),
  }))).toThrow(/path/i)

  for (const url of [
    'https://localhost./qmd.tar.gz',
    'https://127.0.0.2/qmd.tar.gz',
    'https://[::1]/qmd.tar.gz',
    'https://downloads.example.com/qmd.tar.gz',
    'https://downloads.test/qmd.tar.gz',
    'https://downloads.localhost/qmd.tar.gz',
  ]) {
    expect(() => validateRuntimeManifest(manifest({
      assets: manifest().assets.map((asset) => asset.id === 'qmd' ? { ...asset, url } : asset),
    }))).toThrow(/https|endpoint/i)
  }
})
