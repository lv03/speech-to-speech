import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { prepareQmdResources } from '../scripts/prepare-qmd-resources.mjs'

test('copies qmd and its production dependency closure without desktop dev dependencies', async () => {
  const destination = await mkdtemp(join(tmpdir(), 's2s-qmd-resources-'))
  const sourceNodeModules = join(process.cwd(), 'node_modules')

  const copied = await prepareQmdResources({ sourceNodeModules, destination })
  const qmdPackage = JSON.parse(await readFile(join(destination, 'node_modules', '@tobilu', 'qmd', 'package.json'), 'utf8'))

  expect(copied).toContain('@tobilu/qmd')
  expect(qmdPackage.version).toBe('2.8.3')
  expect(copied).toContain('node-llama-cpp')
  expect(copied).toContain('better-sqlite3')
  expect(copied).toContain('sqlite-vec')
  expect(copied).not.toContain('electron')
  expect(copied).not.toContain('vitest')
})

test('uses the lockfile production closure and retains nested package locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-qmd-lock-'))
  const sourceNodeModules = join(root, 'node_modules')
  const destination = join(root, 'output')
  const lockfilePath = join(root, 'package-lock.json')
  const packages = {
    'node_modules/@tobilu/qmd': { version: '2.8.3', dependencies: { kept: '1.0.0', 'dev-only': '1.0.0' } },
    'node_modules/kept': { version: '1.0.0' },
    'node_modules/dev-only': { version: '1.0.0', dev: true },
    'node_modules/kept/node_modules/nested-kept': { version: '1.0.0' },
  }
  for (const [relativePath, manifest] of Object.entries(packages)) {
    const packageRoot = join(root, relativePath)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: relativePath.split('/').at(-1), ...manifest }))
  }
  await writeFile(lockfilePath, JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { '@tobilu/qmd': '2.8.3' } },
    'node_modules/@tobilu/qmd': { version: '2.8.3', dependencies: { kept: '1.0.0' } },
    'node_modules/kept': { version: '1.0.0', dependencies: { 'nested-kept': '1.0.0' } },
    'node_modules/kept/node_modules/nested-kept': { version: '1.0.0' },
    'node_modules/dev-only': { version: '1.0.0', dev: true },
  } }))

  const copied = await prepareQmdResources({ sourceNodeModules, destination, lockfilePath })

  expect(copied).toEqual(['@tobilu/qmd', 'kept', 'nested-kept'])
  await expect(readFile(join(destination, 'node_modules', 'kept', 'node_modules', 'nested-kept', 'package.json'), 'utf8')).resolves.toContain('nested-kept')
  await expect(readFile(join(destination, 'node_modules', 'dev-only', 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
