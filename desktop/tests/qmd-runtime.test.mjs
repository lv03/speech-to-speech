import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { QmdRuntime } from '../src/main/qmd-runtime'

async function createQmdResourceRoot() {
  const root = await mkdtemp(join(tmpdir(), 's2s-qmd-resource-'))
  const packageRoot = join(root, 'node_modules', '@tobilu', 'qmd')
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ bin: { qmd: 'bin/qmd' } }))
  await writeFile(join(packageRoot, 'bin', 'qmd'), '#!/usr/bin/env node\n')
  return root
}

function fakeChild({ exited = false } = {}) {
  const listeners = []
  const child = {
    exitCode: exited ? 1 : null,
    signalCode: null,
    killSignals: [],
    once(event, listener) {
      if (event === 'exit') listeners.push(listener)
      return child
    },
    kill(signal) {
      child.killSignals.push(signal)
      child.exitCode = 0
      for (const listener of listeners) listener(0, signal ?? null)
      return true
    },
  }
  return child
}

test('starts packaged qmd with Electron Node and app-private environment', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-data-'))
  const child = fakeChild()
  let spawnRequest
  const runtime = new QmdRuntime({
    resourceRoot,
    dataRoot,
    portProvider: async () => 8321,
    spawnProcess: (command, args, options) => {
      spawnRequest = { command, args, options }
      return child
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => 'event: message\ndata: {"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"qmd","version":"2.8.3"}}}\n\n',
    }),
  })

  const endpoint = await runtime.start()

  expect(endpoint).toEqual({ baseUrl: 'http://[::1]:8321/mcp', port: 8321 })
  expect(spawnRequest.command).toBe(process.execPath)
  expect(spawnRequest.args).toEqual([
    join(resourceRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd'),
    'mcp',
    '--http',
    '--host',
    '::1',
    '--port',
    '8321',
  ])
  expect(spawnRequest.options.cwd).toBe(resourceRoot)
  expect(spawnRequest.options.env.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(spawnRequest.options.env.HOME).toBe(join(dataRoot, 'home'))
  expect(spawnRequest.options.env.XDG_CONFIG_HOME).toBe(join(dataRoot, 'config'))
  expect(spawnRequest.options.env.XDG_CACHE_HOME).toBe(join(dataRoot, 'cache'))
  expect(spawnRequest.options.env.INDEX_PATH).toBe(join(dataRoot, 'cache', 'qmd', 'index.sqlite'))
  await expect(runtime.health()).resolves.toBe(true)

  await runtime.stop()
  expect(child.killSignals).toEqual([undefined])
})

test('rejects a qmd process that exits before the initialize probe', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-data-'))
  const runtime = new QmdRuntime({
    resourceRoot,
    dataRoot,
    portProvider: async () => 8322,
    spawnProcess: () => fakeChild({ exited: true }),
    fetch: async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => '' }),
  })

  await expect(runtime.start()).rejects.toThrow('exited')
})

test('does not accept an HTTP QMD resource or a non-successful probe', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-data-'))
  const child = fakeChild()
  const runtime = new QmdRuntime({
    resourceRoot,
    dataRoot,
    portProvider: async () => 8323,
    spawnProcess: () => child,
    fetch: async () => ({ ok: false, status: 503, headers: new Headers(), text: async () => '' }),
    startupTimeoutMs: 20,
  })

  await expect(runtime.start()).rejects.toThrow('probe')
  expect(child.killSignals).toEqual([undefined])
})
