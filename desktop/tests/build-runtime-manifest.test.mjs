import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

import { buildManifest } from '../scripts/build-runtime.mjs'

const execFileAsync = promisify(execFile)
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('builds a manifest with bundle paths for resources and no path for userData models', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  const archive = join(root, 'python.tar.gz')
  await writeFile(archive, 'python-runtime')
  const wheelhouse = join(root, 'wheelhouse.tar.gz')
  await writeFile(wheelhouse, 'wheelhouse-runtime')
  const qmd = join(root, 'qmd.tar.gz')
  await writeFile(qmd, 'qmd-runtime')
  const model = join(root, 'embedding.gguf')
  await writeFile(model, 'model-runtime')

  const manifest = await buildManifest({
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    assetRoot: root,
    assets: [{
      id: 'python-runtime',
      version: '2026.09.05',
      kind: 'python-runtime',
      path: archive,
      install: 'resources',
      url: 'https://downloads.example/python.tar.gz',
    }, {
      id: 'wheelhouse',
      version: '2026.09.05',
      kind: 'wheelhouse',
      path: wheelhouse,
      install: 'resources',
      url: 'https://downloads.example/wheelhouse.tar.gz',
    }, {
      id: 'qmd',
      version: '2.8.3',
      kind: 'qmd',
      path: qmd,
      install: 'resources',
      url: 'https://downloads.example/qmd.tar.gz',
    }, {
      id: 'embedding',
      version: '2026.09.05',
      kind: 'model',
      install: 'userData',
      role: 'embedding',
      path: model,
      url: 'https://downloads.example/embedding.gguf',
    }],
  })

  expect(manifest).toMatchObject({
    schemaVersion: 1,
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    approvedProfiles: ['vec-only'],
  })
  expect(manifest.assets).toEqual([
    {
      id: 'python-runtime',
      version: '2026.09.05',
      kind: 'python-runtime',
      install: 'resources',
      path: 'python.tar.gz',
      url: 'https://downloads.example/python.tar.gz',
      size: 14,
      sha256: '1c8d40a759cd016bafb39c3324afed79b90f23e50485b729aea11d8cca2712e7',
    },
    {
      id: 'wheelhouse',
      version: '2026.09.05',
      kind: 'wheelhouse',
      install: 'resources',
      path: 'wheelhouse.tar.gz',
      url: 'https://downloads.example/wheelhouse.tar.gz',
      size: 18,
      sha256: 'a451e0e5f857ac5f8e1171b16e1b252be4168e06075e2fae06ac124849641aff',
    },
    {
      id: 'qmd',
      version: '2.8.3',
      kind: 'qmd',
      install: 'resources',
      path: 'qmd.tar.gz',
      url: 'https://downloads.example/qmd.tar.gz',
      size: 11,
      sha256: 'b76315661e9dafeb1f25c16271403021ff2077fe554f6de09061191c9a982b08',
    },
    {
      id: 'embedding',
      version: '2026.09.05',
      kind: 'model',
      install: 'userData',
      role: 'embedding',
      url: 'https://downloads.example/embedding.gguf',
      size: 13,
      sha256: '2078030b4c9645571a41c7aa95acac474b8ea9a48f6044dc66eb1e086b8cffea',
    },
  ])
})

test('rejects non-HTTPS runtime assets and unsupported platforms', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  const archive = join(root, 'asset.bin')
  await writeFile(archive, 'asset')

  await expect(buildManifest({
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    assets: [{ id: 'python-runtime', version: '1', kind: 'python-runtime', install: 'resources', path: archive, url: 'http://downloads.example/python' }],
  })).rejects.toThrow('HTTPS')

  await expect(buildManifest({
    platform: 'darwin-x64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    assets: [],
  })).rejects.toThrow('darwin-arm64')
})

test('rejects placeholder HTTPS endpoints during manifest construction', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  const archive = join(root, 'asset.bin')
  await writeFile(archive, 'asset')

  for (const url of [
    'https://localhost/runtime',
    'https://127.0.0.2/runtime',
    'https://downloads.example.invalid/runtime',
    'https://downloads.example.com/runtime',
    'https://downloads.test/runtime',
    'https://downloads.localhost/runtime',
  ]) {
    await expect(buildManifest({
      platform: 'darwin-arm64',
      pythonAbi: 'cp311',
      profile: 'voice-default',
      assets: [{
        id: 'python-runtime',
        version: '1',
        kind: 'python-runtime',
        install: 'resources',
        path: archive,
        url,
      }],
    })).rejects.toThrow(/HTTPS|endpoint|placeholder/i)
  }
})

test('rejects runtime assets without an install target or with an unsafe userData kind', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  const assetPath = join(root, 'asset.bin')
  await writeFile(assetPath, 'asset')

  await expect(buildManifest({
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    assetRoot: root,
    assets: [{
      id: 'python-runtime', version: '1', kind: 'python-runtime',
      url: 'https://downloads.example/python', path: assetPath,
    }],
  })).rejects.toThrow(/install/i)

  await expect(buildManifest({
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    assetRoot: root,
    assets: [{
      id: 'qmd', version: '1', kind: 'qmd', install: 'userData',
      url: 'https://downloads.example/qmd',
    }],
  })).rejects.toThrow(/userData|model/i)
})

test('rejects an incomplete runtime manifest before signing', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  const python = join(root, 'python')
  const model = join(root, 'embedding.gguf')
  await writeFile(python, 'python-runtime')
  await writeFile(model, 'model-runtime')

  await expect(buildManifest({
    platform: 'darwin-arm64',
    pythonAbi: 'cp311',
    profile: 'voice-default',
    assetRoot: root,
    assets: [{
      id: 'python-runtime', version: '1', kind: 'python-runtime', install: 'resources',
      path: python, url: 'https://downloads.example/python',
    }, {
      id: 'embedding', version: '1', kind: 'model', role: 'embedding', install: 'userData',
      path: model, url: 'https://downloads.example/embedding',
    }],
  })).rejects.toThrow(/incomplete|wheelhouse|qmd/i)
})

test('keeps resource paths relative to the configured runtime bundle root', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  await mkdir(join(root, 'runtime', 'bin'), { recursive: true })
  await mkdir(join(root, 'runtime', 'wheelhouse'), { recursive: true })
  await mkdir(join(root, 'qmd'), { recursive: true })
  await writeFile(join(root, 'runtime', 'bin', 'python'), 'python')
  await writeFile(join(root, 'runtime', 'wheelhouse', 'resource.tar.gz'), 'wheelhouse')
  await writeFile(join(root, 'qmd', 'resource.tar.gz'), 'qmd')
  await writeFile(join(root, 'embedding.gguf'), 'model')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'manifest-private-key.pem')
  const publicKeyPath = join(root, 'manifest-public-key.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const assetsFile = join(root, 'assets.json')
  const output = join(root, 'runtime-manifest.json')
  const signaturePath = join(root, 'runtime-manifest.json.sig')
  const assetsText = JSON.stringify({
    pythonAbi: 'cp311',
    profile: 'voice-default',
    approvedProfiles: ['vec-only'],
    assets: [
      { id: 'python-runtime', version: '1', kind: 'python-runtime', install: 'resources', path: 'runtime/bin/python', url: 'https://downloads.example/python' },
      { id: 'wheelhouse', version: '1', kind: 'wheelhouse', install: 'resources', path: 'runtime/wheelhouse/resource.tar.gz', url: 'https://downloads.example/wheelhouse' },
      { id: 'qmd', version: '1', kind: 'qmd', install: 'resources', path: 'qmd/resource.tar.gz', url: 'https://downloads.example/qmd' },
      {
        id: 'embedding', version: '1', kind: 'model', role: 'embedding', install: 'userData',
        url: 'https://downloads.example/embedding', size: 5,
        sha256: '9372c470eeadd5ecd9c3c74c2b3cb633f8e2f2fad799250a0f70d652b6b825e4',
      },
    ],
  })
  await writeFile(assetsFile, assetsText)
  const assetsSignaturePath = join(root, 'assets.json.sig')
  await writeFile(assetsSignaturePath, `${sign(null, Buffer.from(assetsText), privateKey).toString('base64')}\n`)

  await execFileAsync(process.execPath, ['scripts/build-runtime.mjs'], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      RUNTIME_MANIFEST_PATH: output,
      RUNTIME_ASSETS_FILE: assetsFile,
      RUNTIME_ASSETS_ROOT: root,
      RUNTIME_PLATFORM: 'darwin-arm64',
      RUNTIME_MANIFEST_PRIVATE_KEY_FILE: privateKeyPath,
      RUNTIME_MANIFEST_PUBLIC_KEY_FILE: publicKeyPath,
      RUNTIME_ASSETS_SIGNATURE_FILE: assetsSignaturePath,
      RUNTIME_MANIFEST_SIGNATURE_FILE: signaturePath,
    },
  })

  const manifestText = await readFile(output, 'utf8')
  const manifest = JSON.parse(manifestText)
  expect(manifest.approvedProfiles).toEqual(['vec-only'])
  expect(manifest.assets.filter(({ install }) => install === 'resources').map(({ path }) => path)).toEqual([
    'runtime/bin/python',
    'runtime/wheelhouse/resource.tar.gz',
    'qmd/resource.tar.gz',
  ])
  expect(manifest.assets.find(({ id }) => id === 'embedding')).not.toHaveProperty('path')
  const signature = Buffer.from((await readFile(signaturePath, 'utf8')).trim(), 'base64')
  expect(verify(null, Buffer.from(manifestText), publicKey, signature)).toBe(true)
})

test('requires and verifies the detached signature of the input runtime asset manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  const assetsFile = join(root, 'assets.json')
  const privateKeyPath = join(root, 'manifest-private-key.pem')
  const publicKeyPath = join(root, 'manifest-public-key.pem')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const assetsText = JSON.stringify({ assets: [] })
  await writeFile(assetsFile, assetsText)

  const baseEnv = {
    ...process.env,
    RUNTIME_ASSETS_FILE: assetsFile,
    RUNTIME_ASSETS_ROOT: root,
    RUNTIME_MANIFEST_PRIVATE_KEY_FILE: privateKeyPath,
    RUNTIME_MANIFEST_PUBLIC_KEY_FILE: publicKeyPath,
    RUNTIME_MANIFEST_PATH: join(root, 'runtime-manifest.json'),
  }

  await expect(execFileAsync(process.execPath, ['scripts/build-runtime.mjs'], {
    cwd: desktopRoot,
    env: baseEnv,
  })).rejects.toThrow(/RUNTIME_ASSETS_SIGNATURE_FILE|signature/i)

  const signaturePath = join(root, 'assets.json.sig')
  await writeFile(signaturePath, `${sign(null, Buffer.from(`${assetsText} tampered`), privateKey).toString('base64')}\n`)
  await expect(execFileAsync(process.execPath, ['scripts/build-runtime.mjs'], {
    cwd: desktopRoot,
    env: { ...baseEnv, RUNTIME_ASSETS_SIGNATURE_FILE: signaturePath },
  })).rejects.toThrow(/signature/i)
})

test('does not allow the JSON runtime asset input to bypass signature verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-manifest-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'manifest-private-key.pem')
  const publicKeyPath = join(root, 'manifest-public-key.pem')
  const signaturePath = join(root, 'assets.json.sig')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const assetsJson = '[]'

  await expect(execFileAsync(process.execPath, ['scripts/build-runtime.mjs'], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      RUNTIME_ASSETS_JSON: assetsJson,
      RUNTIME_MANIFEST_PATH: join(root, 'runtime-manifest.json'),
      RUNTIME_MANIFEST_PRIVATE_KEY_FILE: privateKeyPath,
      RUNTIME_MANIFEST_PUBLIC_KEY_FILE: publicKeyPath,
    },
  })).rejects.toThrow(/RUNTIME_ASSETS_SIGNATURE_FILE|signature/i)

  await writeFile(signaturePath, `${sign(null, Buffer.from(assetsJson), privateKey).toString('base64')}\n`)
  await expect(execFileAsync(process.execPath, ['scripts/build-runtime.mjs'], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      RUNTIME_ASSETS_JSON: assetsJson,
      RUNTIME_ASSETS_SIGNATURE_FILE: signaturePath,
      RUNTIME_MANIFEST_PATH: join(root, 'runtime-manifest.json'),
      RUNTIME_MANIFEST_PRIVATE_KEY_FILE: privateKeyPath,
      RUNTIME_MANIFEST_PUBLIC_KEY_FILE: publicKeyPath,
    },
  })).rejects.toThrow(/incomplete|embedding|wheelhouse|qmd/i)
})
