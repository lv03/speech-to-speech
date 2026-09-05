import { randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { QmdClient } from './qmd-mcp-client'
import type {
  CollectionRecord,
  KnowledgeDocument,
  KnowledgeSearchHit,
  KnowledgeSnapshot,
  LineRange,
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
  reindex(internalName: string): Promise<void>
  deleteIndex(internalName: string): Promise<void>
}

export interface KnowledgeService {
  snapshot(): Promise<KnowledgeSnapshot>
  search(query: string, collectionId?: string, topK?: number): Promise<KnowledgeSearchHit[]>
  getDocument(handle: string, range: LineRange): Promise<KnowledgeDocument>
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
const HANDLE_PATTERN = /^doc_[a-f0-9]{64}$/
const MAX_DOCUMENT_LINES = 80

interface HandleRecord {
  handle: string
  collectionId: string
  collectionName: string
  qmdDocid: string
  relativeFile: string
  title: string
  expiresAt: number
  indexedAt: string | null
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
  return value.length > 0 && value.length <= 120 && !value.includes('\0') &&
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
    (record.indexState === 'pending' || record.indexState === 'indexing' || record.indexState === 'ready' || record.indexState === 'failed')
  )
}

export class QmdService implements KnowledgeService {
  private readonly metadataPath: string
  private readonly client: QmdClient | undefined
  private readonly runner: QmdIndexRunner | undefined
  private readonly now: () => Date
  private readonly handleTtlMs: number
  private readonly maxHandles: number
  private readonly loaded: Promise<void>
  private readonly handles = new Map<string, HandleRecord>()
  private readonly configuredCollections = new Set<string>()
  private writeTail = Promise.resolve()
  private records: CollectionRecord[] = []
  private currentState: RuntimeState

  constructor(options: QmdServiceOptions) {
    this.metadataPath = options.metadataPath
    this.client = options.client
    this.runner = options.runner
    this.now = options.now ?? (() => new Date())
    this.handleTtlMs = options.handleTtlMs ?? 30 * 60 * 1000
    this.maxHandles = options.maxHandles ?? 1024
    this.currentState = state('no_collection', this.now)
    this.loaded = this.load()
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath, 'utf8')) as unknown
      if (Array.isArray(parsed)) this.records = parsed.filter(validPersistedRecord).map((record) => ({ ...record }))
    } catch {
      this.records = []
    }
    this.recalculateState()
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.metadataPath), { recursive: true, mode: 0o700 })
    const temporary = `${this.metadataPath}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.metadataPath)
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
    const failed = this.records.find((record) => record.indexState === 'failed')
    if (failed) {
      this.currentState = state('failed', this.now, failed.collectionId)
      return
    }
    const pending = this.records.find((record) => record.indexState !== 'ready')
    if (pending) {
      this.currentState = state('indexing', this.now, pending.collectionId)
      return
    }
    this.currentState = state('ready_vec', this.now)
  }

  private record(collectionId: string): CollectionRecord {
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
    for (const [handle, record] of this.handles) {
      if (record.collectionId === collectionId) this.handles.delete(handle)
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
      const collectionId = `col_${randomBytes(16).toString('hex')}`
      const record: CollectionRecord = {
        collectionId,
        displayName: name.slice(0, 120),
        root: canonicalRoot,
        include: INCLUDE_PATTERN,
        enabled: true,
        lastIndexedAt: null,
        indexState: 'pending',
      }
      const runner = await this.runnerOrThrow()
      this.records.push(record)
      this.recalculateState()
      await this.save()
      try {
        await runner.add(this.internalName(record), record.root, record.include)
        this.configuredCollections.add(collectionId)
      } catch (error) {
        this.records = this.records.filter((candidate) => candidate.collectionId !== collectionId)
        this.recalculateState()
        await this.save()
        throw new KnowledgeError('knowledge_not_ready', `Knowledge collection could not be added: ${String(error)}`)
      }
      return { ...record }
    })
  }

  async removeCollection(collectionId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.loaded
      const record = this.record(collectionId)
      const runner = await this.runnerOrThrow()
      await runner.remove(this.internalName(record))
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
          this.configuredCollections.add(collectionId)
        }
        await runner.reindex(this.internalName(record))
        record.indexState = 'ready'
        record.lastIndexedAt = this.now().toISOString()
        this.recalculateState()
        await this.save()
      } catch (error) {
        record.indexState = 'failed'
        this.recalculateState()
        await this.save()
        throw new KnowledgeError('knowledge_not_ready', `Knowledge indexing failed: ${String(error)}`)
      }
    })
  }

  async deleteIndex(collectionId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.loaded
      const record = this.record(collectionId)
      const runner = await this.runnerOrThrow()
      await runner.deleteIndex(this.internalName(record))
      this.configuredCollections.delete(collectionId)
      this.invalidateCollectionHandles(collectionId)
      record.indexState = 'pending'
      record.lastIndexedAt = null
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
      this.currentState = state(mode, this.now)
      await this.save()
    })
  }

  async snapshot(): Promise<KnowledgeSnapshot> {
    await this.loaded
    this.recalculateState()
    return {
      state: { ...this.currentState },
      collections: this.records.map((record) => ({ ...record })),
    }
  }

  private recordsFor(collectionId?: string): CollectionRecord[] {
    const records = collectionId
      ? [this.record(collectionId)]
      : this.records.filter((record) => record.enabled)
    if (records.length === 0 || records.some((record) => !record.enabled)) {
      throw new KnowledgeError('no_collection', 'No enabled knowledge collection is configured')
    }
    if (records.some((record) => record.indexState !== 'ready')) {
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
    if (!file || isAbsolute(file)) return null
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

  private issueHandle(record: CollectionRecord, qmdDocid: string, relativeFile: string, title: string): string {
    const handle = `doc_${randomBytes(32).toString('hex')}`
    this.handles.set(handle, {
      handle,
      collectionId: record.collectionId,
      collectionName: record.displayName,
      qmdDocid,
      relativeFile,
      title,
      expiresAt: this.now().getTime() + this.handleTtlMs,
      indexedAt: record.lastIndexedAt,
    })
    while (this.handles.size > this.maxHandles) {
      const oldest = this.handles.keys().next().value
      if (typeof oldest !== 'string') break
      this.handles.delete(oldest)
    }
    return handle
  }

  async search(query: string, collectionId?: string, topK = 5): Promise<KnowledgeSearchHit[]> {
    await this.loaded
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
        results = await this.client.query(cleanQuery, this.internalName(record), topK)
      } catch (error) {
        if (error instanceof KnowledgeError) throw error
        throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
      }
      for (const raw of results) {
        if (typeof raw.docid !== 'string' || !raw.docid) continue
        const relativeFile = await this.safeFile(record, raw.file)
        if (!relativeFile) continue
        const title = typeof raw.title === 'string' && raw.title ? raw.title : relativeFile
        const handle = this.issueHandle(record, raw.docid, relativeFile, title)
        hits.push({
          handle,
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

  async getDocument(handle: string, range: LineRange): Promise<KnowledgeDocument> {
    await this.loaded
    if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) {
      throw new KnowledgeError('document_not_allowed', 'Document handle is not allowed')
    }
    if (
      !Number.isInteger(range?.startLine) || !Number.isInteger(range?.endLine) ||
      range.startLine < 1 || range.endLine < range.startLine ||
      range.endLine - range.startLine + 1 > MAX_DOCUMENT_LINES
    ) {
      throw new KnowledgeError('invalid_request', 'Document range is invalid')
    }
    const stored = this.handles.get(handle)
    if (!stored || stored.expiresAt <= this.now().getTime()) {
      this.handles.delete(handle)
      throw new KnowledgeError('document_not_allowed', 'Document handle is no longer valid')
    }
    const record = this.records.find((candidate) => candidate.collectionId === stored.collectionId)
    if (!record || !record.enabled || record.indexState !== 'ready' || record.lastIndexedAt !== stored.indexedAt) {
      this.handles.delete(handle)
      throw new KnowledgeError('document_not_allowed', 'Document handle is no longer valid')
    }
    const relativeFile = await this.safeFile(record, stored.relativeFile)
    if (!relativeFile || relativeFile !== stored.relativeFile) {
      this.handles.delete(handle)
      throw new KnowledgeError('document_not_allowed', 'Document handle is not allowed')
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
      handle,
      collectionName: record.displayName,
      relativeFile,
      title: stored.title,
      content,
    }
  }
}
