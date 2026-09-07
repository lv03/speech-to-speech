import { mkdtemp, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'

import { PythonRuntime } from '../src/main/python-runtime'
import { EmbeddedGateway } from '../src/main/gateway-process'
import { EmbeddedVoice } from '../src/main/voice-process'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const makeManifest = (assets, overrides = {}) => ({
  schemaVersion: 1,
  platform: 'darwin-arm64',
  pythonAbi: 'cp311',
  profile: 'voice-default',
  approvedProfiles: ['vec-only'],
  assets,
  ...overrides,
})

async function createPackagedFixture(root) {
  const packagedRoot = join(root, 'resources', 'runtime')
  const wheelhouse = join(packagedRoot, 'wheelhouse')
  await mkdir(join(packagedRoot, 'bin'), { recursive: true })
  await mkdir(wheelhouse, { recursive: true })
  await writeFile(join(packagedRoot, 'bin', 'python'), '')
  await writeFile(join(wheelhouse, 'speech_to_speech-1.0.0-py3-none-any.whl'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  return { packagedRoot, wheelhouse }
}

function fakeVenvRunner(calls) {
  return async (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0] === '-m' && args[1] === 'venv') {
      const root = args[args.length - 1]
      await mkdir(join(root, 'bin'), { recursive: true })
      await writeFile(join(root, 'bin', 'python'), '')
    }
  }
}

test('rejects a runtime manifest for another platform before downloading', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const downloads = []
  const runtime = new PythonRuntime({
    userDataDir: root,
    platform: 'darwin-x64',
    manifest: makeManifest([]),
    downloadAsset: async (request) => downloads.push(request),
  })

  await expect(runtime.ensureReady()).rejects.toThrow('darwin-arm64')
  expect(downloads).toHaveLength(0)
})

test('does not download runtime assets in the development path', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const devRoot = join(root, 'checkout')
  const devPython = join(devRoot, '.venv', 'bin', 'python')
  await mkdir(join(devRoot, '.venv', 'bin'), { recursive: true })
  await writeFile(devPython, '')
  const runtime = new PythonRuntime({
    userDataDir: root,
    platform: 'darwin-arm64',
    manifest: makeManifest([]),
    devRoot,
    downloadAsset: async () => { throw new Error('runtime downloads are not a development fallback') },
  })

  await expect(runtime.ensureReady()).resolves.toEqual({
    python: devPython,
    appRoot: devRoot,
    profile: 'development',
  })
})

test('does not fall back to PATH or a development virtualenv when packaged resources are missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const devRoot = join(root, 'checkout')
  const devPython = join(devRoot, '.venv', 'bin', 'python')
  const systemPython = join(root, 'system-python')
  await mkdir(join(devRoot, '.venv', 'bin'), { recursive: true })
  await writeFile(devPython, '')
  await writeFile(systemPython, '')
  const previous = process.env.GATEWAY_PYTHON
  process.env.GATEWAY_PYTHON = systemPython
  const runtime = new PythonRuntime({
    userDataDir: root,
    platform: 'darwin-arm64',
    manifest: makeManifest([]),
    packagedRoot: join(root, 'resources', 'runtime'),
    devRoot,
    downloadAsset: async () => { throw new Error('packaged startup must not download') },
  })
  try {
    await expect(runtime.ensureReady()).rejects.toThrow(/Packaged Python runtime/)
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_PYTHON
    else process.env.GATEWAY_PYTHON = previous
  }
})

test('uses the development virtualenv only when an explicit development root is provided', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const devRoot = join(root, 'checkout')
  const devPython = join(devRoot, '.venv', 'bin', 'python')
  await mkdir(join(devRoot, '.venv', 'bin'), { recursive: true })
  await writeFile(devPython, '')

  const runtime = new PythonRuntime({
    userDataDir: root,
    platform: 'darwin-arm64',
    manifest: makeManifest([]),
    devRoot,
  })

  expect(runtime.paths()).toEqual({ python: devPython, appRoot: devRoot, profile: 'development' })
})

test('uses the packaged Python runtime before any download or development fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const { packagedRoot } = await createPackagedFixture(root)
  const calls = []

  const runtime = new PythonRuntime({
    userDataDir: root,
    manifest: makeManifest([{
      id: 'python-runtime', version: '1.0.0', kind: 'python-runtime', sha256: 'a'.repeat(64),
    }, {
      id: 'wheelhouse', version: '1.0.0', kind: 'wheelhouse', sha256: 'b'.repeat(64),
    }]),
    packagedRoot,
    devRoot: join(root, 'checkout'),
    commandRunner: fakeVenvRunner(calls),
  })

  await expect(runtime.ensureReady()).resolves.toEqual({
    python: join(root, 'runtime', 'python', 'venv', 'bin', 'python'),
    appRoot: packagedRoot,
    profile: 'voice-default',
  })
  const pipInstall = calls.find((call) => call.args.includes('pip'))
  expect(calls[0].args).toEqual(['-m', 'venv', '--symlinks', expect.stringContaining('.tmp')])
  expect(pipInstall.args).toEqual(expect.arrayContaining(['--no-index', '--pre', '--find-links', join(packagedRoot, 'wheelhouse')]))
  expect(pipInstall.options.env.PIP_NO_INDEX).toBe('1')

  const restored = new PythonRuntime({
    userDataDir: root,
    manifest: makeManifest([{
      id: 'python-runtime', version: '1.0.0', kind: 'python-runtime', sha256: 'a'.repeat(64),
    }, {
      id: 'wheelhouse', version: '1.0.0', kind: 'wheelhouse', sha256: 'b'.repeat(64),
    }]),
    packagedRoot,
    commandRunner: async () => { throw new Error('a matching private venv must be reused') },
  })
  await expect(restored.ensureReady()).resolves.toEqual({
    python: join(root, 'runtime', 'python', 'venv', 'bin', 'python'),
    appRoot: packagedRoot,
    profile: 'voice-default',
  })
})

test('reinstalls the private venv when a dependency wheel changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const { packagedRoot, wheelhouse } = await createPackagedFixture(root)
  const manifest = makeManifest([{
    id: 'python-runtime', version: '1.0.0', kind: 'python-runtime', sha256: 'a'.repeat(64),
  }, {
    id: 'wheelhouse', version: '1.0.0', kind: 'wheelhouse', sha256: 'b'.repeat(64),
  }])
  const firstCalls = []
  await new PythonRuntime({
    userDataDir: root,
    manifest,
    packagedRoot,
    commandRunner: fakeVenvRunner(firstCalls),
  }).ensureReady()

  await writeFile(join(wheelhouse, 'dependency-2.0.0-py3-none-any.whl'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const secondCalls = []
  await new PythonRuntime({
    userDataDir: root,
    manifest,
    packagedRoot,
    commandRunner: fakeVenvRunner(secondCalls),
  }).ensureReady()

  expect(firstCalls.some((call) => call.args.includes('venv'))).toBe(true)
  expect(secondCalls.some((call) => call.args.includes('venv'))).toBe(true)
})

test('rejects a packaged runtime without a usable wheelhouse before running Python', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const packagedRoot = join(root, 'resources', 'runtime')
  await mkdir(join(packagedRoot, 'bin'), { recursive: true })
  await writeFile(join(packagedRoot, 'bin', 'python'), '')
  const calls = []
  const runtime = new PythonRuntime({
    userDataDir: root,
    platform: 'darwin-arm64',
    manifest: makeManifest([]),
    packagedRoot,
    commandRunner: fakeVenvRunner(calls),
  })

  await expect(runtime.ensureReady()).rejects.toThrow(/wheelhouse/i)
  expect(calls).toHaveLength(0)
})

test('rejects a wheelhouse symlink that escapes packaged resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const packagedRoot = join(root, 'resources', 'runtime')
  const outsideWheelhouse = join(root, 'outside-wheelhouse')
  await mkdir(join(packagedRoot, 'bin'), { recursive: true })
  await mkdir(outsideWheelhouse, { recursive: true })
  await writeFile(join(packagedRoot, 'bin', 'python'), '')
  await writeFile(join(outsideWheelhouse, 'speech_to_speech-1.0.0-py3-none-any.whl'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  await symlink(outsideWheelhouse, join(packagedRoot, 'wheelhouse'))
  const calls = []
  const runtime = new PythonRuntime({
    userDataDir: root,
    platform: 'darwin-arm64',
    manifest: makeManifest([]),
    packagedRoot,
    commandRunner: fakeVenvRunner(calls),
  })

  await expect(runtime.ensureReady()).rejects.toThrow(/escapes|wheelhouse/i)
  expect(calls).toHaveLength(0)
})

test('packaged process wrappers require PythonRuntime paths instead of probing fallbacks', () => {
  expect(() => new EmbeddedGateway({ mode: 'packaged' })).toThrow(/PythonRuntime|runtime/i)
  expect(() => new EmbeddedVoice({ mode: 'packaged' })).toThrow(/PythonRuntime|runtime/i)
})
