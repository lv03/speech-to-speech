import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
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
      queueMicrotask(() => listener(0, null))
      return this
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
  expect(calls.every((call) => call.options.stdio === 'ignore')).toBe(true)
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
