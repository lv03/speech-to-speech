import { verify, type KeyLike } from 'node:crypto'
import { isAbsolute } from 'node:path'

import type { RuntimeAsset, RuntimeManifest, RuntimeModelRole } from './runtime-types'

const SUPPORTED_PLATFORM = 'darwin-arm64'
const ASSET_KINDS = new Set(['python-runtime', 'wheelhouse', 'qmd', 'model'])
const INSTALL_TARGETS = new Set(['resources', 'userData'])
const MODEL_ROLES = new Set<RuntimeModelRole>(['embedding', 'reranker', 'generator'])
const APPROVED_PROFILES = new Set(['vec-only', 'hybrid'])

export interface ManifestVerificationOptions {
  requireSignature?: boolean
}

function fail(message: string): never {
  throw new Error(`Knowledge runtime manifest ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function roleForAsset(asset: RuntimeAsset): RuntimeModelRole | undefined {
  if (asset.role) return asset.role
  if (asset.id === 'embedding') return 'embedding'
  if (asset.id === 'reranker' || asset.id === 'rerank') return 'reranker'
  if (asset.id === 'generator' || asset.id === 'generation') return 'generator'
  return undefined
}

function validateUrl(value: unknown): void {
  if (typeof value !== 'string') fail('asset URL is invalid')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    fail('asset URL is invalid')
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
  const isLoopback = hostname === '127.0.0.1' || hostname.startsWith('127.') || hostname === '0.0.0.0' || hostname === '[::1]' || hostname === '::1'
  if (parsed.protocol !== 'https:' || !hostname || isLoopback || isReservedHostname) {
    fail('asset URL must use an approved HTTPS endpoint')
  }
}

function validateAsset(value: unknown, ids: Set<string>, kinds: Set<string>, roles: Set<string>): RuntimeAsset {
  if (!isRecord(value)) fail('asset is invalid')
  const asset = value as Partial<RuntimeAsset>
  const size = asset.size as number
  if (
    typeof asset.id !== 'string' || !asset.id.trim() || ids.has(asset.id) ||
    typeof asset.version !== 'string' || !asset.version.trim() ||
    typeof asset.kind !== 'string' || !ASSET_KINDS.has(asset.kind) ||
    (asset.kind !== 'model' && kinds.has(asset.kind)) ||
    typeof asset.install !== 'string' || !INSTALL_TARGETS.has(asset.install) ||
    (asset.install === 'userData' && asset.kind !== 'model') ||
    (asset.install === 'resources' && (typeof asset.path !== 'string' || !asset.path)) ||
    (asset.install === 'userData' && asset.path !== undefined) ||
    !Number.isSafeInteger(size) || size <= 0 ||
    typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    (asset.kind !== 'model' && asset.role !== undefined) ||
    (asset.kind === 'model' && (typeof asset.role !== 'string' || !MODEL_ROLES.has(asset.role) || roles.has(asset.role)))
  ) {
    fail('asset is invalid')
  }
  validateUrl(asset.url)
  const role = asset.role as RuntimeModelRole | undefined
  if (asset.install === 'resources') {
    const path = asset.path as string
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      fail('asset path is invalid')
    }
  }
  const normalized = { ...asset } as RuntimeAsset
  ids.add(asset.id as string)
  kinds.add(asset.kind as string)
  if (role) roles.add(role)
  return normalized
}

export function validateRuntimeManifest(value: unknown): RuntimeManifest {
  if (!isRecord(value)) fail('is invalid')
  if (
    value.schemaVersion !== 1 || value.platform !== SUPPORTED_PLATFORM ||
    value.profile !== 'voice-default' || typeof value.pythonAbi !== 'string' || !value.pythonAbi.trim() ||
    !Array.isArray(value.approvedProfiles) ||
    value.approvedProfiles.length === 0 ||
    value.approvedProfiles.some((profile) => typeof profile !== 'string' || !APPROVED_PROFILES.has(profile)) ||
    new Set(value.approvedProfiles).size !== value.approvedProfiles.length ||
    !value.approvedProfiles.includes('vec-only') ||
    !Array.isArray(value.assets)
  ) {
    fail('approvedProfiles must include vec-only and contain only supported profiles')
  }

  const ids = new Set<string>()
  const kinds = new Set<string>()
  const roles = new Set<string>()
  const assets = value.assets.map((asset) => validateAsset(asset, ids, kinds, roles))
  if (['python-runtime', 'wheelhouse', 'qmd'].some((kind) => !kinds.has(kind))) fail('is incomplete')

  const modelRoles = new Set<RuntimeModelRole>()
  for (const asset of assets) {
    const role = roleForAsset(asset)
    if (role) modelRoles.add(role)
  }
  if (!modelRoles.has('embedding')) fail('has no embedding model')
  if (value.approvedProfiles.includes('hybrid') && !(['embedding', 'reranker', 'generator'] as RuntimeModelRole[]).every((role) => modelRoles.has(role))) {
    fail('approves hybrid without all required model roles')
  }

  return { ...value, assets } as RuntimeManifest
}

function decodeSignature(value: string): Buffer {
  const encoded = value.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) fail('signature is invalid')
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length !== 64) fail('signature is invalid')
  return decoded
}

export function parseAndVerifyRuntimeManifest(
  text: string,
  signature: string | undefined,
  publicKey: KeyLike | undefined,
  options: ManifestVerificationOptions = {},
): RuntimeManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('is not valid JSON')
  }
  const manifest = validateRuntimeManifest(parsed)
  if (!options.requireSignature) return manifest
  if (!signature || !publicKey) fail('signature is required')
  const signatureBytes = decodeSignature(signature)
  if (!verify(null, Buffer.from(text, 'utf8'), publicKey, signatureBytes)) fail('signature verification failed')
  return manifest
}
