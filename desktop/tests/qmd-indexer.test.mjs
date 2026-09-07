import { chmod, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { QmdIndexer } from '../src/main/qmd-indexer'

async function createQmdResourceRoot() {
  const root = await mkdtemp(join(tmpdir(), 's2s-qmd-indexer-resource-'))
  const entrypoint = join(root, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd')
  await mkdir(join(entrypoint, '..'), { recursive: true })
  await writeFile(entrypoint, '#!/usr/bin/env node\n')
  return root
}

function successfulChild() {
  return {
    exitCode: 0,
    signalCode: null,
    once(_event, listener) {
      if (_event === 'exit') queueMicrotask(() => listener(0, null))
      return this
    },
    kill: () => true,
  }
}

function childWithExit(code, stderr = '') {
  const stream = {
    on(event, listener) {
      if (event === 'data' && stderr) queueMicrotask(() => listener(Buffer.from(stderr)))
      return this
    },
  }
  return {
    exitCode: null,
    signalCode: null,
    stdout: stream,
    stderr: stream,
    once(_event, listener) {
      if (_event === 'exit') queueMicrotask(() => listener(code, null))
      return this
    },
    kill: () => true,
  }
}

function childWithError(error) {
  let errorListener
  return {
    exitCode: null,
    signalCode: null,
    once(event, listener) {
      if (event === 'error') errorListener = listener
      return this
    },
    emitError() {
      queueMicrotask(() => errorListener?.(error))
    },
    kill: () => true,
  }
}

test('runs only fixed QMD index commands in the private QMD environment', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-indexer-data-'))
  const collectionRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-collection-'))
  const canonicalRoot = await realpath(collectionRoot)
  const calls = []
  const indexer = new QmdIndexer({
    resourceRoot,
    dataRoot,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options })
      return successfulChild()
    },
  })

  await indexer.add('kb_col_0123456789abcdef0123456789abcdef', collectionRoot, '**/*.md')
  await indexer.embed()
  await indexer.reindex('kb_col_0123456789abcdef0123456789abcdef')
  await indexer.deleteIndex('kb_col_0123456789abcdef0123456789abcdef')
  await indexer.remove('kb_col_0123456789abcdef0123456789abcdef')

  expect(calls.map((call) => call.args)).toEqual([
    [join(resourceRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd'), 'collection', 'add', canonicalRoot, '--name', 'kb_col_0123456789abcdef0123456789abcdef', '--mask', '**/*.md'],
    [join(resourceRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd'), 'embed'],
    [join(resourceRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd'), 'update'],
    [join(resourceRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd'), 'embed', '--force'],
    [join(resourceRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd'), 'collection', 'remove', 'kb_col_0123456789abcdef0123456789abcdef'],
    [join(resourceRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd'), 'collection', 'remove', 'kb_col_0123456789abcdef0123456789abcdef'],
  ])
  expect(calls.every((call) => call.command === process.execPath)).toBe(true)
  expect(calls.map((call) => call.options.stdio)).toEqual(
    calls.map(() => ['ignore', 'pipe', 'pipe']),
  )
  expect(calls.every((call) => call.options.env.INDEX_PATH === join(dataRoot, 'qmd', 'cache', 'qmd', 'index.sqlite'))).toBe(true)
  expect(calls.every((call) => call.options.env.HOME === join(dataRoot, 'qmd', 'home'))).toBe(true)
  expect(calls.every((call) => call.options.env.XDG_CONFIG_HOME === join(dataRoot, 'qmd', 'config'))).toBe(true)
  expect(calls.every((call) => call.options.env.QMD_CONFIG_DIR === join(dataRoot, 'qmd', 'config', 'qmd'))).toBe(true)
  expect(calls.every((call) => call.options.env.XDG_CACHE_HOME === join(dataRoot, 'qmd', 'cache'))).toBe(true)
})

test('rejects arbitrary names, roots, and masks before spawning QMD', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-indexer-data-'))
  const indexer = new QmdIndexer({ resourceRoot, dataRoot, spawnProcess: () => successfulChild() })

  await expect(indexer.add('shell; id', '/tmp', '**/*.md')).rejects.toThrow('collection name')
  await expect(indexer.add('kb_col_0123456789abcdef0123456789abcdef', '/tmp', '**/*.txt')).rejects.toThrow('mask')
})

test('rejects immediately when the QMD index process emits an error', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-indexer-error-'))
  let child
  const indexer = new QmdIndexer({
    resourceRoot,
    dataRoot,
    spawnProcess: () => {
      child = childWithError(new Error('spawn failed'))
      queueMicrotask(() => child.emitError())
      return child
    },
  })

  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 100))
  await expect(Promise.race([indexer.embed(), timeout])).rejects.toThrow('QMD index operation failed')
})

test('repairs permissions on pre-existing QMD directories and files', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-indexer-permissions-'))
  const qmdRoot = join(dataRoot, 'qmd')
  const indexPath = join(qmdRoot, 'cache', 'qmd', 'index.sqlite')
  const configPath = join(qmdRoot, 'config', 'qmd', 'index.yml')
  await mkdir(join(qmdRoot, 'cache', 'qmd'), { recursive: true, mode: 0o755 })
  await mkdir(join(qmdRoot, 'config', 'qmd'), { recursive: true, mode: 0o755 })
  await writeFile(indexPath, '', { mode: 0o644 })
  await writeFile(configPath, 'models: {}\n', { mode: 0o644 })
  await chmod(join(qmdRoot, 'cache'), 0o755)
  await chmod(join(qmdRoot, 'config'), 0o755)

  const collectionRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-indexer-collection-'))
  const indexer = new QmdIndexer({
    resourceRoot,
    dataRoot,
    spawnProcess: () => successfulChild(),
  })

  await indexer.add('kb_col_0123456789abcdef0123456789abcdef', collectionRoot, '**/*.md')

  for (const path of [
    qmdRoot,
    join(qmdRoot, 'home'),
    join(qmdRoot, 'config'),
    join(qmdRoot, 'config', 'qmd'),
    join(qmdRoot, 'cache'),
    join(qmdRoot, 'cache', 'qmd'),
  ]) {
    expect((await stat(path)).mode & 0o777).toBe(0o700)
  }
  expect((await stat(indexPath)).mode & 0o777).toBe(0o600)
  expect((await stat(configPath)).mode & 0o777).toBe(0o600)
})

test('recreates a collection only when QMD reports that it is missing', async () => {
  const resourceRoot = await createQmdResourceRoot()
  const dataRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-indexer-recreate-'))
  const collectionRoot = await mkdtemp(join(tmpdir(), 's2s-qmd-indexer-collection-'))
  let invocation = 0
  const calls = []
  const indexer = new QmdIndexer({
    resourceRoot,
    dataRoot,
    spawnProcess: (command, args, options) => {
      calls.push(args)
      invocation += 1
      return invocation === 1
        ? childWithExit(1, 'Collection not found: kb_col_0123456789abcdef0123456789abcdef')
        : successfulChild()
    },
  })

  await indexer.reindex(
    'kb_col_0123456789abcdef0123456789abcdef',
    collectionRoot,
    '**/*.md',
  )

  expect(calls.map((args) => args.slice(1, 3))).toEqual([
    ['update'],
    ['collection', 'add'],
    ['update'],
    ['embed', '--force'],
  ])
  expect(calls[1]).toContain(await realpath(collectionRoot))
})
