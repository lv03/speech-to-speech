import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { QmdClient } from './qmd-mcp-client'
import type {
  CollectionRecord,
  KnowledgeDocument,
  KnowledgeSearchHit,
  KnowledgeSnapshot,
  LineRange,
  RetrievalMode,
  RuntimeState,
  RuntimeStateName,
} from './runtime-types'

export type KnowledgeErrorCode =
  | 'no_collection'
  | 'knowledge_not_ready'
  | 'knowledge_indexing'
  | 'no_results'
  | 'document_not_allowed'
  | 'proxy_unavailable'
  | 'invalid_request'
  | 'collection_invalid'
  | 'collection_exists'
  | 'collection_limit'

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode

  constructor(code: KnowledgeErrorCode, message: string) {
    super(message)
    this.name = 'KnowledgeError'
    this.code = code
  }
}

export interface QmdIndexRunner {
  add(internalName: string, root: string, include: string): Promise<void>
  remove(internalName: string): Promise<void>
  reindex(internalName: string, root?: string, include?: string): Promise<void>
  deleteIndex(internalName: string): Promise<void>
}

export interface KnowledgeService {
  snapshot(): Promise<KnowledgeSnapshot>
  search(query: string, collectionId?: string, topK?: number): Promise<KnowledgeSearchHit[]>
  getDocument(docid: string, range: LineRange): Promise<KnowledgeDocument>
  setRetrievalMode?(mode: RetrievalMode): void
  setIndexFingerprint?(fingerprint: string): void
}

export interface QmdServiceOptions {
  metadataPath: string
  client?: QmdClient
  runner?: QmdIndexRunner
  now?: () => Date
  handleTtlMs?: number
  maxHandles?: number
}

const INCLUDE_PATTERN = '**/*.md' as const
const DOCID_PATTERN = /^doc_[a-f0-9]{64}$/
const MAX_DOCUMENT_LINES = 80
const MAX_ENABLED_COLLECTIONS = 32

interface DocidRecord {
  docid: string
  collectionId: string
  collectionName: string
  qmdDocid: string
  relativeFile: string
  title: string
  expiresAt: number
  indexedAt: string | null
}

interface PersistedCollectionRecord extends CollectionRecord {
  qmdConfigured: boolean
}

function state(name: RuntimeStateName, now: () => Date, collectionId?: string, reason?: string): RuntimeState {
  return {
    name,
    ...(collectionId ? { collectionId } : {}),
    ...(reason ? { reason } : {}),
    updatedAt: now().toISOString(),
  }
}

function isInside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child !== '' && !child.startsWith('..') && !isAbsolute(child)
}

function normalizeSourcePath(file: string): string {
  return file.split(sep).join('/')
}

function validDisplayName(value: string): boolean {
  return value !== '.' && value !== '..' && value.length > 0 && value.length <= 120 && !value.includes('\0') &&
    !value.includes('/') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/.test(value)
}

function validPersistedRecord(value: unknown): value is CollectionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<CollectionRecord>
  return (
    typeof record.collectionId === 'string' && /^col_[a-f0-9]{32}$/.test(record.collectionId) &&
    typeof record.displayName === 'string' && validDisplayName(record.displayName) &&
    typeof record.root === 'string' && isAbsolute(record.root) &&
    record.include === INCLUDE_PATTERN &&
    typeof record.enabled === 'boolean' &&
    (record.lastIndexedAt === null || typeof record.lastIndexedAt === 'string') &&
    (record.indexState === 'pending' || record.indexState === 'indexing' || record.indexState === 'ready' || record.indexState === 'failed') &&
    (record.indexFingerprint === undefined || record.indexFingerprint === null ||
      (typeof record.indexFingerprint === 'string' && /^[a-f0-9]{64}$/.test(record.indexFingerprint)))
  )
}

function qmdConfigured(value: CollectionRecord): boolean {
  const configured = (value as Partial<PersistedCollectionRecord>).qmdConfigured
  return typeof configured === 'boolean' ? configured : value.indexState === 'ready'
}

function publicRecord(value: PersistedCollectionRecord): CollectionRecord {
  const { qmdConfigured: _qmdConfigured, ...record } = value
  return record
}

export class QmdService implements KnowledgeService {
  private readonly metadataPath: string
  private client: QmdClient | undefined
  private readonly runner: QmdIndexRunner | undefined
  private readonly now: () => Date
  private readonly docidTtlMs: number
  private readonly maxDocids: number
  private readonly loaded: Promise<void>
  private readonly docids = new Map<string, DocidRecord>()
  private readonly configuredCollections = new Set<string>()
  private writeTail = Promise.resolve()
  private records: PersistedCollectionRecord[] = []
  private currentState: RuntimeState
  private runtimeState: RuntimeState | null = null
  private retrievalMode: RetrievalMode = 'vec-only'
  private currentIndexFingerprint: string | null = null
  private fingerprintMutation = Promise.resolve()

  constructor(options: QmdServiceOptions) {
    this.metadataPath = options.metadataPath
    this.client = options.client
    this.runner = options.runner
    this.now = options.now ?? (() => new Date())
    this.docidTtlMs = options.handleTtlMs ?? 30 * 60 * 1000
    this.maxDocids = options.maxHandles ?? 1024
    this.currentState = state('no_collection', this.now)
    this.loaded = this.load()
  }

  /** Binds the current QMD daemon without exposing its endpoint to callers. */
  setClient(client: QmdClient | undefined): void {
    this.client = client
    if (!client) this.invalidateHandles()
  }

  invalidateHandles(): void {
    this.docids.clear()
  }

  /** Lets RuntimeManager publish daemon availability separately from index state. */
  setRuntimeState(runtimeState: RuntimeState | null): void {
    this.runtimeState = runtimeState ? { ...runtimeState } : null
    this.recalculateState()
  }

  setRetrievalMode(mode: RetrievalMode): void {
    this.retrievalMode = mode
    this.recalculateState()
  }

  setIndexFingerprint(fingerprint: string): void {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Knowledge index fingerprint is invalid')
    this.currentIndexFingerprint = fingerprint
    this.fingerprintMutation = this.enqueue(async () => {
      await this.loaded
      let changed = false
      for (const record of this.records) {
        if (record.indexState !== 'ready' || record.indexFingerprint === fingerprint) continue
        record.indexState = 'pending'
        record.indexFingerprint = null
        record.lastIndexedAt = null
        this.invalidateCollectionHandles(record.collectionId)
        changed = true
      }
      this.recalculateState()
      if (changed) await this.save()
    })
  }

  private async load(): Promise<void> {
    try {
      await this.protectMetadata()
      const parsed = JSON.parse(await readFile(this.metadataPath, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        this.records = parsed.filter(validPersistedRecord).map((record) => ({
          ...record,
          indexFingerprint: record.indexFingerprint ?? null,
          qmdConfigured: qmdConfigured(record),
        }))
        for (const record of this.records) {
          if (record.qmdConfigured) this.configuredCollections.add(record.collectionId)
        }
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      this.records = []
    }
    this.recalculateState()
  }

  private async save(): Promise<void> {
    await this.protectMetadata()
    const temporary = `${this.metadataPath}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.metadataPath)
    await chmod(this.metadataPath, 0o600)
  }

  private async protectMetadata(): Promise<void> {
    const directory = dirname(this.metadataPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    try {
      await chmod(this.metadataPath, 0o600)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') throw error
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeTail.then(operation, operation)
    this.writeTail = next.then(() => undefined, () => undefined)
    return next
  }

  private recalculateState(): void {
    if (this.records.length === 0) {
      this.currentState = state('no_collection', this.now)
      return
    }
    if (this.runtimeState) {
      this.currentState = { ...this.runtimeState }
      return
    }
    const failed = this.records.find((record) => record.indexState === 'failed')
    if (failed) {
      this.currentState = state('failed', this.now, failed.collectionId)
      return
    }
    const pending = this.records.find((record) => record.indexState !== 'ready' ||
      (this.currentIndexFingerprint !== null && record.indexFingerprint !== this.currentIndexFingerprint))
    if (pending) {
      this.currentState = state('indexing', this.now, pending.collectionId)
      return
    }
    this.currentState = state('ready_vec', this.now)
  }

  private record(collectionId: string): PersistedCollectionRecord {
    const record = this.records.find((candidate) => candidate.collectionId === collectionId)
    if (!record) throw new KnowledgeError('no_collection', 'Knowledge collection is not configured')
    return record
  }

  private async runnerOrThrow(): Promise<QmdIndexRunner> {
    if (!this.runner) throw new KnowledgeError('knowledge_not_ready', 'Knowledge indexing is not available')
    return this.runner
  }

  private async canonicalDirectory(root: string): Promise<string> {
    if (typeof root !== 'string' || !root.trim() || root.includes('\0')) {
      throw new KnowledgeError('collection_invalid', 'Knowledge collection directory is invalid')
    }
    try {
      const canonical = await realpath(root.trim())
      const metadata = await stat(canonical)
      if (!metadata.isDirectory()) throw new Error('not a directory')
      return canonical
    } catch {
      throw new KnowledgeError('collection_invalid', 'Knowledge collection directory is unavailable')
    }
  }

  private internalName(record: CollectionRecord): string {
    return `kb_${record.collectionId}`
  }

  private invalidateCollectionHandles(collectionId: string): void {
    for (const [docid, record] of this.docids) {
      if (record.collectionId === collectionId) this.docids.delete(docid)
    }
  }

  async addCollection(root: string, displayName?: string): Promise<CollectionRecord> {
    return this.enqueue(async () => {
      await this.loaded
      const canonicalRoot = await this.canonicalDirectory(root)
      if (this.records.some((record) => record.root === canonicalRoot)) {
        throw new KnowledgeError('collection_exists', 'This knowledge collection is already configured')
      }
      const name = (typeof displayName === 'string' ? displayName.trim() : '') || basename(canonicalRoot)
      if (!validDisplayName(name)) throw new KnowledgeError('collection_invalid', 'Knowledge collection name is invalid')
      if (this.records.filter((record) => record.enabled).length >= MAX_ENABLED_COLLECTIONS) {
        throw new KnowledgeError('collection_limit', 'The maximum number of enabled knowledge collections is 32')
      }
      const collectionId = `col_${randomBytes(16).toString('hex')}`
      const record: CollectionRecord = {
        collectionId,
        displayName: name.slice(0, 120),
        root: canonicalRoot,
        include: INCLUDE_PATTERN,
        enabled: true,
        lastIndexedAt: null,
        indexState: 'pending',
        indexFingerprint: null,
      }
      const persisted: PersistedCollectionRecord = { ...record, qmdConfigured: false }
      this.records.push(persisted)
      this.recalculateState()
      await this.save()
      return publicRecord(persisted)
    })
  }

  async removeCollection(collectionId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.loaded
      const record = this.record(collectionId)
      if (qmdConfigured(record)) {
        const runner = await this.runnerOrThrow()
        await runner.remove(this.internalName(record))
      }
      this.configuredCollections.delete(collectionId)
      this.invalidateCollectionHandles(collectionId)
      this.records = this.records.filter((candidate) => candidate.collectionId !== collectionId)
      this.recalculateState()
      await this.save()
    })
  }

  async reindex(collectionId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.loaded
      const record = this.record(collectionId)
      const runner = await this.runnerOrThrow()
      record.indexState = 'indexing'
      this.invalidateCollectionHandles(collectionId)
      this.recalculateState()
      await this.save()
      try {
        if (!this.configuredCollections.has(collectionId)) {
          await runner.add(this.internalName(record), record.root, record.include)
          record.qmdConfigured = true
          this.configuredCollections.add(collectionId)
          await this.save()
        }
        await runner.reindex(this.internalName(record), record.root, record.include)
        record.indexState = 'ready'
        record.lastIndexedAt = this.now().toISOString()
        record.indexFingerprint = this.currentIndexFingerprint
        this.recalculateState()
        await this.save()
      } catch (error) {
        record.indexState = 'failed'
        this.recalculateState()
        await this.save()
        throw new KnowledgeError('knowledge_not_ready', 'Knowledge indexing failed')
      }
    })
  }

  async deleteIndex(collectionId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.loaded
      const record = this.record(collectionId)
      if (qmdConfigured(record)) {
        const runner = await this.runnerOrThrow()
        await runner.deleteIndex(this.internalName(record))
      }
      this.configuredCollections.delete(collectionId)
      this.invalidateCollectionHandles(collectionId)
      record.qmdConfigured = false
      record.indexState = 'pending'
      record.lastIndexedAt = null
      record.indexFingerprint = null
      this.recalculateState()
      await this.save()
    })
  }

  async markReady(collectionId: string, mode: 'ready_vec' | 'ready_hybrid' = 'ready_vec'): Promise<void> {
    return this.enqueue(async () => {
      await this.loaded
      const record = this.record(collectionId)
      record.indexState = 'ready'
      record.lastIndexedAt = record.lastIndexedAt ?? this.now().toISOString()
      record.indexFingerprint = this.currentIndexFingerprint
      this.currentState = state(mode, this.now)
      await this.save()
    })
  }

  async snapshot(): Promise<KnowledgeSnapshot> {
    await this.loaded
    await this.fingerprintMutation
    this.recalculateState()
    return {
      state: { ...this.currentState },
      collections: this.records.map((record) => publicRecord(record)),
    }
  }

  private recordsFor(collectionId?: string): CollectionRecord[] {
    const records = collectionId
      ? [this.record(collectionId)]
      : this.records.filter((record) => record.enabled)
    if (records.length === 0 || records.some((record) => !record.enabled)) {
      throw new KnowledgeError('no_collection', 'No enabled knowledge collection is configured')
    }
    if (records.some((record) => record.indexState !== 'ready' ||
      (this.currentIndexFingerprint !== null && record.indexFingerprint !== this.currentIndexFingerprint))) {
      throw new KnowledgeError('knowledge_indexing', 'Knowledge index is not ready')
    }
    return records
  }

  private async safeFile(record: CollectionRecord, rawFile: unknown): Promise<string | null> {
    if (typeof rawFile !== 'string' || !rawFile || rawFile.includes('\0') || rawFile.includes('\\')) return null
    let file = rawFile
    if (file.startsWith('qmd://')) {
      try {
        const parsed = new URL(file)
        if (parsed.protocol !== 'qmd:' || parsed.hostname !== this.internalName(record)) return null
        file = decodeURIComponent(parsed.pathname).replace(/^\//, '')
      } catch {
        return null
      }
    }
    const collectionPrefix = `${this.internalName(record)}/`
    if (file.startsWith(collectionPrefix)) file = file.slice(collectionPrefix.length)
    if (
      !file || isAbsolute(file) || file.includes('\0') || file.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(file) ||
      file.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) return null
    const candidate = resolve(record.root, file)
    if (!isInside(record.root, candidate)) return null
    try {
      const realRoot = await realpath(record.root)
      const realFile = await realpath(candidate)
      if (!isInside(realRoot, realFile)) return null
      return normalizeSourcePath(relative(realRoot, realFile))
    } catch {
      return null
    }
  }

  private issueDocid(record: CollectionRecord, qmdDocid: string, relativeFile: string, title: string): string {
    const docid = `doc_${randomBytes(32).toString('hex')}`
    this.docids.set(docid, {
      docid,
      collectionId: record.collectionId,
      collectionName: record.displayName,
      qmdDocid,
      relativeFile,
      title,
      expiresAt: this.now().getTime() + this.docidTtlMs,
      indexedAt: record.lastIndexedAt,
    })
    while (this.docids.size > this.maxDocids) {
      const oldest = this.docids.keys().next().value
      if (typeof oldest !== 'string') break
      this.docids.delete(oldest)
    }
    return docid
  }

  async search(query: string, collectionId?: string, topK = 5): Promise<KnowledgeSearchHit[]> {
    await this.loaded
    await this.fingerprintMutation
    const cleanQuery = typeof query === 'string' ? query.trim() : ''
    if (!cleanQuery) throw new KnowledgeError('invalid_request', 'Knowledge query is empty')
    if (cleanQuery.length > 2000 || !Number.isInteger(topK) || topK < 1 || topK > 8) {
      throw new KnowledgeError('invalid_request', 'Knowledge query is invalid')
    }
    const records = this.recordsFor(collectionId)
    if (!this.client) throw new KnowledgeError('knowledge_not_ready', 'Knowledge search is not ready')

    const hits: KnowledgeSearchHit[] = []
    for (const record of records) {
      let results
      try {
        results = await this.client.query(
          cleanQuery,
          this.internalName(record),
          topK,
          this.retrievalMode, // 'vec-only' | 'hybrid' | 'full'
        )
      } catch (error) {
        if (error instanceof KnowledgeError) throw error
        throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
      }
      for (const raw of results) {
        if (typeof raw.docid !== 'string' || !raw.docid) continue
        const relativeFile = await this.safeFile(record, raw.file)
        if (!relativeFile) continue
        const title = typeof raw.title === 'string' && raw.title ? raw.title : relativeFile
        const docid = this.issueDocid(record, raw.docid, relativeFile, title)
        hits.push({
          docid,
          collectionId: record.collectionId,
          collectionName: record.displayName,
          relativeFile,
          title,
          score: typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : 0,
          snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
          ...(typeof raw.line === 'number' && Number.isInteger(raw.line) && raw.line > 0 ? { line: raw.line } : {}),
        })
      }
    }
    return hits.sort((left, right) => right.score - left.score).slice(0, topK)
  }

  async getDocument(docid: string, range: LineRange): Promise<KnowledgeDocument> {
    await this.loaded
    await this.fingerprintMutation
    if (typeof docid !== 'string' || !DOCID_PATTERN.test(docid)) {
      throw new KnowledgeError('document_not_allowed', 'Document id is not allowed')
    }
    if (
      !Number.isInteger(range?.startLine) || !Number.isInteger(range?.endLine) ||
      range.startLine < 1 || range.endLine < range.startLine ||
      range.endLine - range.startLine + 1 > MAX_DOCUMENT_LINES
    ) {
      throw new KnowledgeError('invalid_request', 'Document range is invalid')
    }
    const stored = this.docids.get(docid)
    if (!stored || stored.expiresAt <= this.now().getTime()) {
      this.docids.delete(docid)
      throw new KnowledgeError('document_not_allowed', 'Document id is no longer valid')
    }
    const record = this.records.find((candidate) => candidate.collectionId === stored.collectionId)
    if (!record || !record.enabled || record.indexState !== 'ready' ||
      (this.currentIndexFingerprint !== null && record.indexFingerprint !== this.currentIndexFingerprint) ||
      record.lastIndexedAt !== stored.indexedAt) {
      this.docids.delete(docid)
      throw new KnowledgeError('document_not_allowed', 'Document id is no longer valid')
    }
    const relativeFile = await this.safeFile(record, stored.relativeFile)
    if (!relativeFile || relativeFile !== stored.relativeFile) {
      this.docids.delete(docid)
      throw new KnowledgeError('document_not_allowed', 'Document id is not allowed')
    }
    if (!this.client) throw new KnowledgeError('knowledge_not_ready', 'Knowledge search is not ready')
    let content: string
    try {
      content = await this.client.get(stored.qmdDocid, range.startLine, range.endLine - range.startLine + 1)
    } catch (error) {
      if (error instanceof KnowledgeError) throw error
      throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
    }
    if (typeof content !== 'string') throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
    return {
      docid,
      collectionName: record.displayName,
      relativeFile,
      title: stored.title,
      content,
    }
  }
}
