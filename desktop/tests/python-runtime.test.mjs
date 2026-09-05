import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'

import { PythonRuntime } from '../src/main/python-runtime'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const makeManifest = (assets) => ({
  schemaVersion: 1,
  platform: 'darwin-arm64',
  pythonAbi: 'cp311',
  profile: 'voice-default',
  assets,
})

const asset = (id, content, kind) => ({
  id,
  version: '1.0.0',
  kind,
  url: `https://runtime.example/${id}`,
  size: content.length,
  sha256: sha256(content),
})

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

test('resumes an asset download and installs wheels without an index', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const python = asset('python-runtime', 'python-bundle', 'python-runtime')
  const uv = asset('uv', 'uv-binary', 'uv')
  const wheelhouse = asset('wheelhouse', 'locked-wheels', 'wheelhouse')
  const manifest = makeManifest([python, uv, wheelhouse])
  const commands = []
  const requests = []
  const runtime = new PythonRuntime({
    userDataDir: root,
    platform: 'darwin-arm64',
    manifest,
    downloadAsset: async ({ asset: requested, target, resumeFrom }) => {
      requests.push({ id: requested.id, resumeFrom })
      const content = requested.id === 'python-runtime' ? 'python-bundle' : requested.id === 'uv' ? 'uv-binary' : 'locked-wheels'
      await writeFile(target, content)
    },
    extractArchive: async (archive, destination, requested) => {
      if (requested.id === 'python-runtime') {
        await mkdir(join(destination, 'bin'), { recursive: true })
        await writeFile(join(destination, 'bin', 'python'), await import('node:fs/promises').then(({ readFile }) => readFile(archive)))
      } else {
        await mkdir(destination, { recursive: true })
        await writeFile(join(destination, 'ready'), await import('node:fs/promises').then(({ readFile }) => readFile(archive)))
      }
    },
    runCommand: async (command, args) => {
      commands.push({ command, args })
    },
  })

  const partial = join(root, 'runtime', 'python', 'voice-default', '.python-runtime.part')
  await mkdir(join(root, 'runtime', 'python', 'voice-default'), { recursive: true })
  await writeFile(partial, 'python-')

  const paths = await runtime.ensureReady()

  expect(paths.python).toBe(join(root, 'runtime', 'python', 'voice-default', 'bin', 'python'))
  expect(requests.find(({ id }) => id === 'python-runtime')).toMatchObject({ resumeFrom: 7 })
  expect(commands).toHaveLength(1)
  expect(commands[0].args).toEqual(expect.arrayContaining(['--no-index', '--find-links']))
  expect(commands[0].args).toContain('speech-to-speech')
  expect(commands[0].args).toContain('speech-to-speech-gateway')
})

test('removes a failed asset download after SHA-256 verification fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-runtime-'))
  const invalid = {
    ...asset('python-runtime', 'expected', 'python-runtime'),
    sha256: '0'.repeat(64),
  }
  const uv = asset('uv', 'uv-binary', 'uv')
  const wheelhouse = asset('wheelhouse', 'locked-wheels', 'wheelhouse')
  const runtime = new PythonRuntime({
    userDataDir: root,
    platform: 'darwin-arm64',
    manifest: makeManifest([invalid, uv, wheelhouse]),
    downloadAsset: async ({ asset: requested, target }) => {
      await writeFile(target, requested.id === 'python-runtime' ? 'tampered' : requested.id)
    },
  })

  await expect(runtime.ensureReady()).rejects.toThrow('SHA-256')
  const runtimeRoot = join(root, 'runtime', 'python', 'voice-default')
  await expect(readdir(runtimeRoot)).resolves.not.toContain('.python-runtime.part')
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
