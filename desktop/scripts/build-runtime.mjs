import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SUPPORTED_PLATFORM = 'darwin-arm64'

function validateHttps(url) {
  if (new URL(url).protocol !== 'https:') {
    throw new Error(`Runtime asset URL must use HTTPS: ${url}`)
  }
}

export async function buildManifest(options) {
  if (options.platform !== SUPPORTED_PLATFORM) {
    throw new Error(`Unsupported runtime platform: ${options.platform}; expected ${SUPPORTED_PLATFORM}`)
  }
  if (!Array.isArray(options.assets)) throw new Error('Runtime assets must be an array')

  const assets = []
  for (const input of options.assets) {
    if (!input || typeof input !== 'object') throw new Error('Runtime asset descriptors must be objects')
    if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('Runtime asset id must not be empty')
    if (typeof input.version !== 'string' || !input.version.trim()) throw new Error(`Runtime asset ${input.id} has no version`)
    if (typeof input.kind !== 'string' || !input.kind.trim()) throw new Error(`Runtime asset ${input.id} has no kind`)
    if (typeof input.path !== 'string' || !input.path) throw new Error(`Runtime asset ${input.id} has no path`)
    validateHttps(input.url)

    const [contents, metadata] = await Promise.all([readFile(input.path), stat(input.path)])
    if (!metadata.isFile()) throw new Error(`Runtime asset is not a file: ${input.path}`)
    assets.push({
      id: input.id,
      version: input.version,
      kind: input.kind,
      url: input.url,
      size: metadata.size,
      sha256: createHash('sha256').update(contents).digest('hex'),
    })
  }

  return {
    schemaVersion: 1,
    platform: SUPPORTED_PLATFORM,
    pythonAbi: options.pythonAbi,
    profile: options.profile,
    assets,
  }
}

async function main() {
  const manifestPath = process.env.RUNTIME_MANIFEST_PATH
  const assetsJson = process.env.RUNTIME_ASSETS_JSON
  if (!manifestPath || !assetsJson) {
    throw new Error('RUNTIME_MANIFEST_PATH and RUNTIME_ASSETS_JSON are required')
  }
  const manifest = await buildManifest({
    platform: process.env.RUNTIME_PLATFORM || SUPPORTED_PLATFORM,
    pythonAbi: process.env.RUNTIME_PYTHON_ABI || 'cp311',
    profile: process.env.RUNTIME_PROFILE || 'voice-default',
    assets: JSON.parse(assetsJson),
  })
  await writeFile(resolve(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
