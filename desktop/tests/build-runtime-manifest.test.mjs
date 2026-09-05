import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { buildManifest } from '../scripts/build-runtime.mjs'

test('builds a runtime manifest with asset sizes and SHA-256 values', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  const archive = join(root, 'python.tar.gz')
  await writeFile(archive, 'python-runtime')

  const manifest = await buildManifest({
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    assets: [{
      id: 'python-runtime',
      version: '2026.09.05',
      kind: 'python-runtime',
      path: archive,
      url: 'https://downloads.example/python.tar.gz',
    }],
  })

  expect(manifest).toMatchObject({
    schemaVersion: 1,
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
  })
  expect(manifest.assets).toEqual([{
    id: 'python-runtime',
    version: '2026.09.05',
    kind: 'python-runtime',
    url: 'https://downloads.example/python.tar.gz',
    size: 14,
    sha256: '1c8d40a759cd016bafb39c3324afed79b90f23e50485b729aea11d8cca2712e7',
  }])
})

test('rejects non-HTTPS runtime assets and unsupported platforms', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  const archive = join(root, 'asset.bin')
  await writeFile(archive, 'asset')

  await expect(buildManifest({
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    assets: [{ id: 'uv', version: '1', kind: 'uv', path: archive, url: 'http://downloads.example/uv' }],
  })).rejects.toThrow('HTTPS')

  await expect(buildManifest({
    platform: 'darwin-x64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    assets: [],
  })).rejects.toThrow('darwin-arm64')
})
