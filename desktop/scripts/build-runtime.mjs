import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const SUPPORTED_PLATFORM = 'darwin-arm64'
const ASSET_KINDS = new Set(['python-runtime', 'wheelhouse', 'qmd', 'model'])
const INSTALL_TARGETS = new Set(['resources', 'userData'])
const MODEL_ROLES = new Set(['embedding', 'reranker', 'generator'])
const APPROVED_PROFILES = new Set(['vec-only', 'hybrid'])

async function verifyInputManifestSignature(manifestText) {
  const signaturePath = process.env.RUNTIME_ASSETS_SIGNATURE_FILE
  const publicKeyPath = process.env.RUNTIME_MANIFEST_PUBLIC_KEY_FILE
  if (!signaturePath || !publicKeyPath) {
    throw new Error('RUNTIME_ASSETS_SIGNATURE_FILE and RUNTIME_MANIFEST_PUBLIC_KEY_FILE are required for signed runtime assets')
  }

  const encodedSignature = (await readFile(resolve(signaturePath), 'utf8')).trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedSignature) || encodedSignature.length % 4 !== 0) {
    throw new Error('Runtime asset manifest signature is invalid')
  }
  const signature = Buffer.from(encodedSignature, 'base64')
  if (signature.length !== 64) throw new Error('Runtime asset manifest signature is invalid')

  const publicKey = createPublicKey(await readFile(resolve(publicKeyPath)))
  if (!verify(null, Buffer.from(manifestText, 'utf8'), publicKey, signature)) {
    throw new Error('Runtime asset manifest signature verification failed')
  }
}

function roleFor(input) {
  if (input.role) return input.role
  if (input.id === 'embedding') return 'embedding'
  if (input.id === 'reranker' || input.id === 'rerank') return 'reranker'
  if (input.id === 'generator' || input.id === 'generation') return 'generator'
  return undefined
}

function validateHttps(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Runtime asset URL is invalid: ${url}`)
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const isReservedHostname =
    hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname === 'invalid' || hostname.endsWith('.invalid') ||
    hostname === 'test' || hostname.endsWith('.test') ||
    hostname === 'local' || hostname.endsWith('.local') ||
    hostname === 'example.com' || hostname.endsWith('.example.com') ||
    hostname === 'example.net' || hostname.endsWith('.example.net') ||
    hostname === 'example.org' || hostname.endsWith('.example.org')
  if (
    parsed.protocol !== 'https:' ||
    !hostname ||
    isReservedHostname ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('127.') ||
    hostname === '0.0.0.0' ||
    hostname === '[::1]' ||
    hostname === '::1'
  ) {
    throw new Error(`Runtime asset URL must use HTTPS: ${url}`)
  }
}

export async function buildManifest(options) {
  if (options.platform !== SUPPORTED_PLATFORM) {
    throw new Error(`Unsupported runtime platform: ${options.platform}; expected ${SUPPORTED_PLATFORM}`)
  }
  if (typeof options.pythonAbi !== 'string' || !options.pythonAbi.trim()) {
    throw new Error('Runtime manifest python ABI is required')
  }
  if (options.profile !== 'voice-default') {
    throw new Error('Runtime manifest profile must be voice-default')
  }
  if (!Array.isArray(options.assets)) throw new Error('Runtime assets must be an array')
  const approvedProfiles = options.approvedProfiles ?? ['vec-only']
  if (
    !Array.isArray(approvedProfiles) || approvedProfiles.length === 0 ||
    approvedProfiles.some((profile) => typeof profile !== 'string' || !APPROVED_PROFILES.has(profile)) ||
    new Set(approvedProfiles).size !== approvedProfiles.length ||
    !approvedProfiles.includes('vec-only')
  ) {
    throw new Error('Runtime manifest approvedProfiles must include vec-only')
  }

  const assets = []
  const ids = new Set()
  const kinds = new Set()
  const modelRoles = new Set()
  for (const input of options.assets) {
    if (!input || typeof input !== 'object') throw new Error('Runtime asset descriptors must be objects')
    if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('Runtime asset id must not be empty')
    if (ids.has(input.id)) throw new Error(`Runtime asset id is duplicated: ${input.id}`)
    if (typeof input.version !== 'string' || !input.version.trim()) throw new Error(`Runtime asset ${input.id} has no version`)
    if (!ASSET_KINDS.has(input.kind)) throw new Error(`Runtime asset ${input.id} has an unsupported kind`)
    if (input.kind !== 'model' && kinds.has(input.kind)) throw new Error(`Runtime asset kind is duplicated: ${input.kind}`)
    const role = input.kind === 'model' ? roleFor(input) : undefined
    if (input.kind === 'model') {
      if (!role || !MODEL_ROLES.has(role)) throw new Error(`Runtime asset ${input.id} has an unsupported model role`)
      if (modelRoles.has(role)) throw new Error(`Runtime model role is duplicated: ${role}`)
      modelRoles.add(role)
    }
    if (!INSTALL_TARGETS.has(input.install)) throw new Error(`Runtime asset ${input.id} has an invalid install target`)
    if (input.install === 'userData' && input.kind !== 'model') {
      throw new Error(`Only model assets may install to userData: ${input.id}`)
    }
    if (input.install === 'resources' && (typeof input.path !== 'string' || !input.path)) {
      throw new Error(`Resource asset ${input.id} must provide a bundle path`)
    }
    validateHttps(input.url)

    let size = input.size
    let sha256 = input.sha256
    let bundlePath
    if (input.path) {
      const sourcePath = resolve(options.assetRoot || dirname(resolve(input.path)), input.path)
      const [contents, metadata] = await Promise.all([readFile(sourcePath), stat(sourcePath)])
      if (!metadata.isFile()) throw new Error(`Runtime asset is not a file: ${sourcePath}`)
      size = metadata.size
      sha256 = createHash('sha256').update(contents).digest('hex')
      if (input.install === 'resources') {
        const root = resolve(options.assetRoot || dirname(sourcePath))
        const child = relative(root, sourcePath)
        if (child.startsWith('..') || isAbsolute(child)) throw new Error(`Runtime asset path escapes asset root: ${input.id}`)
        bundlePath = child.split(sep).join('/')
      }
    }
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Runtime asset ${input.id} has an invalid size`)
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Runtime asset ${input.id} has an invalid SHA-256`)
    }
    const asset = {
      id: input.id,
      version: input.version,
      kind: input.kind,
      install: input.install,
      url: input.url,
      size,
      sha256,
    }
    if (role !== undefined) asset.role = role
    if (bundlePath) asset.path = bundlePath
    assets.push(asset)
    ids.add(input.id)
    kinds.add(input.kind)
  }

  const missingKinds = ['python-runtime', 'wheelhouse', 'qmd'].filter((kind) => !kinds.has(kind))
  if (missingKinds.length > 0) throw new Error(`Runtime manifest is incomplete; missing ${missingKinds.join(', ')}`)
  if (!modelRoles.has('embedding')) throw new Error('Runtime manifest requires an embedding model')
  if (approvedProfiles.includes('hybrid') && !['embedding', 'reranker', 'generator'].every((role) => modelRoles.has(role))) {
    throw new Error('Runtime manifest cannot approve hybrid without all model roles')
  }

  return {
    schemaVersion: 1,
    platform: SUPPORTED_PLATFORM,
    pythonAbi: options.pythonAbi,
    profile: options.profile,
    approvedProfiles,
    assets,
  }
}

async function main() {
  const manifestPath = process.env.RUNTIME_MANIFEST_PATH || resolve('build/runtime-manifest.json')
  const assetsFile = process.env.RUNTIME_ASSETS_FILE
  const assetsJson = process.env.RUNTIME_ASSETS_JSON
  let config
  let assetRoot
  if (assetsFile) {
    const filePath = resolve(assetsFile)
    const manifestText = await readFile(filePath, 'utf8')
    await verifyInputManifestSignature(manifestText)
    config = JSON.parse(manifestText)
    const root = resolve(process.env.RUNTIME_ASSETS_ROOT || dirname(filePath))
    assetRoot = root
    config.assets = config.assets?.map((asset) => {
      if (!asset || typeof asset !== 'object') {
        throw new Error('Runtime asset descriptors in RUNTIME_ASSETS_FILE are invalid')
      }
      if (asset.install === 'userData') {
        if (asset.path !== undefined) throw new Error('User-data runtime assets must not provide a bundle path')
        return asset
      }
      if (typeof asset.path !== 'string' || isAbsolute(asset.path)) {
        throw new Error('Runtime asset paths in RUNTIME_ASSETS_FILE must be relative')
      }
      const path = resolve(root, asset.path)
      const child = relative(root, path)
      if (child.startsWith('..') || isAbsolute(child)) throw new Error('Runtime asset path escapes RUNTIME_ASSETS_ROOT')
      return { ...asset, path }
    })
  } else if (assetsJson) {
    await verifyInputManifestSignature(assetsJson)
    config = { assets: JSON.parse(assetsJson) }
    assetRoot = process.env.RUNTIME_ASSETS_ROOT ? resolve(process.env.RUNTIME_ASSETS_ROOT) : undefined
  } else {
    throw new Error('RUNTIME_ASSETS_JSON or RUNTIME_ASSETS_FILE is required')
  }
  const manifest = await buildManifest({
    platform: process.env.RUNTIME_PLATFORM || SUPPORTED_PLATFORM,
    pythonAbi: process.env.RUNTIME_PYTHON_ABI || config.pythonAbi || 'cp311',
    profile: process.env.RUNTIME_PROFILE || config.profile || 'voice-default',
    approvedProfiles: config.approvedProfiles || ['vec-only'],
    assets: config.assets,
    assetRoot,
  })
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const privateKeyPath = process.env.RUNTIME_MANIFEST_PRIVATE_KEY_FILE
  if (!privateKeyPath) throw new Error('RUNTIME_MANIFEST_PRIVATE_KEY_FILE is required for a signed runtime manifest')
  const privateKey = await readFile(resolve(privateKeyPath), 'utf8')
  const signaturePath = resolve(process.env.RUNTIME_MANIFEST_SIGNATURE_FILE || `${manifestPath}.sig`)
  const signature = sign(null, Buffer.from(manifestText, 'utf8'), privateKey).toString('base64')
  await writeFile(resolve(manifestPath), manifestText, 'utf8')
  await writeFile(signaturePath, `${signature}\n`, { encoding: 'utf8', mode: 0o600 })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
