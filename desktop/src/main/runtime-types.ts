export type RuntimeAssetKind = 'python-runtime' | 'wheelhouse' | 'qmd' | 'model'
export type RuntimeAssetInstall = 'resources' | 'userData'
export type RuntimeModelRole = 'embedding' | 'reranker' | 'generator'
export type RetrievalMode = 'vec-only' | 'hybrid' | 'full'
export type RetrievalPreference = 'auto' | RetrievalMode
export type ApprovedRetrievalProfile = 'vec-only' | 'hybrid'

export interface RuntimeAsset {
  id: string
  version: string
  kind: RuntimeAssetKind
  install: RuntimeAssetInstall
  path?: string
  url: string
  size: number
  sha256: string
  role?: RuntimeModelRole
}

export interface RetrievalProfile {
  mode: ApprovedRetrievalProfile
  embeddingAssetId: string
  rerankerAssetId?: string
  generatorAssetId?: string
}

export interface RetrievalProfiles {
  vecOnly: RetrievalProfile | null
  hybrid: RetrievalProfile | null
}

export interface RuntimeManifest {
  schemaVersion: 1
  platform: 'darwin-arm64'
  pythonAbi: string
  profile: 'voice-default'
  approvedProfiles: ApprovedRetrievalProfile[]
  assets: RuntimeAsset[]
}

export interface RuntimePaths {
  python: string
  appRoot: string
  profile: string
}

export type RuntimeStateName =
  | 'no_collection'
  | 'needs_consent'
  | 'downloading'
  | 'installing'
  | 'indexing'
  | 'ready_hybrid'
  | 'ready_vec'
  | 'degraded'
  | 'failed'
  | 'stopping'

export interface RuntimeState {
  name: RuntimeStateName
  collectionId?: string
  progress?: { completed: number; total: number }
  reason?: string
  updatedAt: string
}

export interface CollectionRecord {
  collectionId: string
  displayName: string
  root: string
  include: '**/*.md'
  enabled: boolean
  lastIndexedAt: string | null
  indexState: 'pending' | 'indexing' | 'ready' | 'failed'
  indexFingerprint: string | null
}

export interface KnowledgeSnapshot {
  state: RuntimeState
  collections: CollectionRecord[]
}

export type KnowledgeModelState =
  | 'not_needed'
  | 'needs_consent'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'failed'

export interface KnowledgeModelStatus {
  state: KnowledgeModelState
  downloadBytes: number
  diskBytes: number
  completedBytes?: number
  reason?: string
  mode?: RetrievalMode
  availableModes?: RetrievalMode[]
}

export interface PublicKnowledgeCollection {
  collectionId: string
  displayName: string
  directory: string
  indexState: CollectionRecord['indexState']
  lastIndexedAt: string | null
}

export interface PublicKnowledgeSnapshot {
  state: RuntimeStateName
  reason?: string
  model: KnowledgeModelStatus
  collections: PublicKnowledgeCollection[]
}

export function sanitizePublicReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const reason = value.trim()
  if (
    !reason || reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason) || reason.includes('\\') ||
    reason.startsWith('/') || /\b[A-Za-z]:\//.test(reason) || /(?:qmd|file|https?):\/\//i.test(reason)
  ) return undefined
  return reason
}

export function publicModelStatus(status: KnowledgeModelStatus): KnowledgeModelStatus {
  const reason = sanitizePublicReason(status.reason)
  const { reason: _reason, ...withoutReason } = status
  return {
    ...withoutReason,
    ...(reason ? { reason } : {}),
  }
}

export interface QmdSearchResult {
  docid: string
  file: string
  title: string
  score: number
  snippet: string
  line?: number
}

export interface QmdStatus {
  totalDocuments: number
  needsEmbedding: number
  hasVectorIndex: boolean
  collections: Array<{ name: string; documents: number }>
}

export interface LineRange {
  startLine: number
  endLine: number
}

export interface KnowledgeSearchHit {
  docid: string
  collectionId: string
  collectionName: string
  relativeFile: string
  title: string
  score: number
  snippet: string
  line?: number
}

export interface KnowledgeDocument {
  docid: string
  collectionName: string
  relativeFile: string
  title: string
  content: string
}
