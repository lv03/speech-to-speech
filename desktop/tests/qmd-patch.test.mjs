import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const { applyQmdEmbedRoutePatch } = await import('../scripts/prepare-qmd-resources.mjs')

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCHES = resolve(HERE, '..', 'patches')
const REAL_SERVER = resolve(HERE, '..', 'node_modules/@tobilu/qmd/dist/mcp/server.js')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 's2s-qmd-patch-'))
  const target = join(root, 'node_modules/@tobilu/qmd/dist/mcp')
  await cp(dirname(REAL_SERVER), target, { recursive: true })
  return root
}

test('applies the embed route patch once and is idempotent', async () => {
  const destination = await fixture()
  const serverFile = join(destination, 'node_modules/@tobilu/qmd/dist/mcp/server.js')

  expect(await applyQmdEmbedRoutePatch(destination, { patchesDirectory: PATCHES })).toBe('applied')
  const patched = await readFile(serverFile, 'utf8')
  expect(patched).toContain('pathname === "/embed"')
  expect(patched).toContain('getDefaultLlamaCpp')

  expect(await applyQmdEmbedRoutePatch(destination, { patchesDirectory: PATCHES })).toBe('already')
  expect(await readFile(serverFile, 'utf8')).toBe(patched)
})

test('fails loudly when the target layout does not match the patch', async () => {
  const destination = await fixture()
  const serverFile = join(destination, 'node_modules/@tobilu/qmd/dist/mcp/server.js')
  await writeFile(serverFile, 'export const nothing = true\n')

  await expect(applyQmdEmbedRoutePatch(destination, { patchesDirectory: PATCHES })).rejects.toThrow(/embed route|Failed to apply/)
})
