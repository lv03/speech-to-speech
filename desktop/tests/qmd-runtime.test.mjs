import { chmod, mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises'
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
    emitExit(code = 1, signal = 'SIGTERM') {
      child.exitCode = code
      for (const listener of listeners) listener(code, signal)
    },
  }
  return child
}

function fakeErrorChild() {
  const exitListeners = []
  let errorListener
  const child = {
    exitCode: null,
    signalCode: null,
    once(event, listener) {
      if (event === 'exit') exitListeners.push(listener)
      if (event === 'error') errorListener = listener
      return child
    },
    kill(signal) {
      child.killSignals.push(signal)
      child.exitCode = 0
      for (const listener of exitListeners) listener(0, signal ?? null)
      return true
    },
    killSignals: [],
    emitError(error) {
      errorListener?.(error)
    },
  }
  return child
}

test('starts packaged qmd with Electron Node and app-private environment', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-data-'))
  const qmdRoot = join(dataRoot, 'qmd')
  await mkdir(qmdRoot)
  await chmod(qmdRoot, 0o755)
  const configDir = join(qmdRoot, 'config', 'qmd')
  await mkdir(configDir, { recursive: true, mode: 0o755 })
  const configPath = join(configDir, 'index.yml')
  await writeFile(configPath, 'models: {}\n', { mode: 0o644 })
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
  expect(spawnRequest.options.env.HOME).toBe(join(dataRoot, 'qmd', 'home'))
  expect(spawnRequest.options.env.XDG_CONFIG_HOME).toBe(join(dataRoot, 'qmd', 'config'))
  expect(spawnRequest.options.env.QMD_CONFIG_DIR).toBe(join(dataRoot, 'qmd', 'config', 'qmd'))
  expect(spawnRequest.options.env.XDG_CACHE_HOME).toBe(join(dataRoot, 'qmd', 'cache'))
  expect(spawnRequest.options.env.INDEX_PATH).toBe(join(dataRoot, 'qmd', 'cache', 'qmd', 'index.sqlite'))
  for (const path of [
    qmdRoot,
    join(dataRoot, 'qmd', 'home'),
    join(dataRoot, 'qmd', 'config'),
    join(dataRoot, 'qmd', 'config', 'qmd'),
    join(dataRoot, 'qmd', 'cache'),
    join(dataRoot, 'qmd', 'cache', 'qmd'),
  ]) {
    expect((await stat(path)).mode & 0o777).toBe(0o700)
  }
  expect((await stat(join(dataRoot, 'qmd', 'cache', 'qmd', 'index.sqlite'))).mode & 0o777).toBe(0o600)
  expect((await stat(configPath)).mode & 0o777).toBe(0o600)
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

test('rejects immediately when the qmd process emits an error during startup', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-data-'))
  let child
  const runtime = new QmdRuntime({
    resourceRoot,
    dataRoot,
    portProvider: async () => 8325,
    spawnProcess: () => {
      child = fakeErrorChild()
      queueMicrotask(() => child.emitError(new Error('spawn failed')))
      return child
    },
    probe: async () => false,
    startupTimeoutMs: 100,
  })

  await expect(runtime.start()).rejects.toThrow('QMD process failed')
  expect(child.killSignals).toEqual([undefined])
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

test('reports an unexpected daemon exit and clears its endpoint', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-data-'))
  const child = fakeChild()
  const exits = []
  const runtime = new QmdRuntime({
    resourceRoot,
    dataRoot,
    portProvider: async () => 8324,
    spawnProcess: () => child,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => 'event: message\ndata: {"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"qmd","version":"2.8.3"}}}\n\n',
    }),
  })
  runtime.onExit((event) => exits.push(event))

  await runtime.start()
  child.emitExit()

  expect(exits).toEqual([{ unexpected: true, code: 1, signal: 'SIGTERM' }])
  expect(runtime.endpoint).toBeNull()
})
