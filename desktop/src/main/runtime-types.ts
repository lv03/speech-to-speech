export type RuntimeAssetKind = 'python-runtime' | 'uv' | 'wheelhouse' | 'qmd' | 'model'

export interface RuntimeAsset {
  id: string
  version: string
  kind: RuntimeAssetKind
  url: string
  size: number
  sha256: string
}

export interface RuntimeManifest {
  schemaVersion: 1
  platform: 'darwin-arm64'
  pythonAbi: string
  profile: 'voice-default'
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
}

export interface KnowledgeSnapshot {
  state: RuntimeState
  collections: CollectionRecord[]
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
  handle: string
  collectionId: string
  collectionName: string
  relativeFile: string
  title: string
  score: number
  snippet: string
  line?: number
}

export interface KnowledgeDocument {
  handle: string
  collectionName: string
  relativeFile: string
  title: string
  content: string
}
