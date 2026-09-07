import { createHash } from 'node:crypto'

import type {
  RetrievalProfile,
  RetrievalProfiles,
  RuntimeAsset,
  RuntimeManifest,
  RuntimeModelRole,
} from './runtime-types'

function roleFor(asset: RuntimeAsset): RuntimeModelRole | undefined {
  if (asset.kind !== 'model') return undefined
  if (asset.role) return asset.role
  if (asset.id === 'embedding') return 'embedding'
  if (asset.id === 'reranker' || asset.id === 'rerank') return 'reranker'
  if (asset.id === 'generator' || asset.id === 'generation') return 'generator'
  return undefined
}

function assetIdFor(assets: RuntimeAsset[], role: RuntimeModelRole): string | undefined {
  return assets.find((asset) => roleFor(asset) === role)?.id
}

export function getRetrievalProfiles(manifest: RuntimeManifest): RetrievalProfiles {
  const assets = manifest.assets.filter((asset) => asset.kind === 'model')
  const embeddingAssetId = assetIdFor(assets, 'embedding')
  if (!embeddingAssetId) return { vecOnly: null, hybrid: null }

  const vecOnly: RetrievalProfile = { mode: 'vec-only', embeddingAssetId }
  const rerankerAssetId = assetIdFor(assets, 'reranker')
  const generatorAssetId = assetIdFor(assets, 'generator')
  const approvedProfiles = new Set(manifest.approvedProfiles ?? ['vec-only'])
  const hybrid = approvedProfiles.has('hybrid') && rerankerAssetId && generatorAssetId
    ? { mode: 'hybrid' as const, embeddingAssetId, rerankerAssetId, generatorAssetId }
    : null
  return { vecOnly, hybrid }
}

export function profileAssetIds(profile: RetrievalProfile): string[] {
  return [profile.embeddingAssetId, profile.rerankerAssetId, profile.generatorAssetId]
    .filter((assetId): assetId is string => Boolean(assetId))
}

export function getIndexFingerprint(
  manifest: RuntimeManifest,
  profile: RetrievalProfile | null,
  qmdVersion: string,
): string {
  const assets = profile
    ? profileAssetIds(profile).map((id) => {
      const asset = manifest.assets.find((candidate) => candidate.id === id)
      if (!asset) throw new Error(`Retrieval profile asset is missing: ${id}`)
      return { id: asset.id, version: asset.version }
    })
    : []
  const payload = JSON.stringify({
    indexFormat: 1,
    mode: profile?.mode ?? 'unavailable',
    qmdVersion,
    assets,
  })
  return createHash('sha256').update(payload).digest('hex')
}
