import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'

import {
  KnowledgeError,
  type KnowledgeService,
} from './qmd-service'

export interface QmdProxyEndpoint {
  url: string
  token: string
}

export interface QmdProxyOptions {
  service: KnowledgeService
  host?: '127.0.0.1' | '::1'
  portProvider?: () => Promise<number>
  token?: string
  maxQueryLength?: number
  maxTopK?: number
  maxBodyBytes?: number
  maxResponseBytes?: number
  maxDocumentLines?: number
  handleTtlMs?: number
  maxHandles?: number
  now?: () => number
}

const MAX_CONTENT_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const DOCID_PATTERN = /^doc_[a-f0-9]{64}$/

function defaultErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    no_collection: 'No knowledge collection is configured',
    knowledge_not_ready: 'Knowledge base is not ready',
    knowledge_indexing: 'Knowledge base is indexing',
    no_results: 'No knowledge results found',
    document_not_allowed: 'Document id is not allowed',
    proxy_unavailable: 'Knowledge service is unavailable',
    invalid_request: 'Invalid knowledge request',
    collection_invalid: 'Knowledge collection is invalid',
    collection_exists: 'Knowledge collection already exists',
    collection_limit: 'The maximum number of knowledge collections has been reached',
  }
  return messages[code] ?? 'Knowledge request failed'
}

function statusForError(code: string): number {
  if (code === 'document_not_allowed') return 403
  if (code === 'proxy_unavailable' || code === 'knowledge_not_ready') return 503
  if (code === 'invalid_request' || code === 'collection_invalid' || code === 'collection_exists' || code === 'collection_limit') return 400
  return 200
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  const truncated = value.slice(0, low)
  return truncated.length > 0 && /[\uD800-\uDBFF]/.test(truncated.at(-1) ?? '')
    ? truncated.slice(0, -1)
    : truncated
}

function fitDocumentContent(base: Record<string, unknown>, content: string, maxResponseBytes: number): string {
  const bounded = truncateUtf8(content, MAX_CONTENT_BYTES)
  if (Buffer.byteLength(JSON.stringify({ ...base, content: bounded }), 'utf8') <= maxResponseBytes) return bounded

  const codePoints = Array.from(bounded)
  let low = 0
  let high = codePoints.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = codePoints.slice(0, middle).join('')
    if (Buffer.byteLength(JSON.stringify({ ...base, content: candidate }), 'utf8') <= maxResponseBytes) low = middle
    else high = middle - 1
  }
  return codePoints.slice(0, low).join('')
}

function hasPublicRelativeFile(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) &&
    !value.includes('\0') && !value.includes('\\') &&
    !value.split('/').some((part) => part === '..' || part === '')
}

function hasPublicCollectionName(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' && value.length > 0 && value.length <= 120 &&
    !value.includes('\0') && !value.includes('/') && !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(value)
}

function publicTitle(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const title = value.trim()
  if (!title || title.length > 240 || isAbsolute(title) || title.startsWith('qmd:') || title.startsWith('file:') ||
    title.includes('\\') || /[\u0000-\u001f\u007f]/.test(title)) return fallback
  return title
}

export class QmdProxy {
  private readonly service: KnowledgeService
  private readonly host: '127.0.0.1' | '::1'
  private readonly portProvider: () => Promise<number>
  private readonly maxQueryLength: number
  private readonly maxTopK: number
  private readonly maxBodyBytes: number
  private readonly maxResponseBytes: number
  private readonly maxDocumentLines: number
  private readonly docidTtlMs: number
  private readonly maxDocids: number
  private readonly now: () => number
  private readonly token: string
  private readonly issuedDocids = new Map<string, number>()
  private server: Server | null = null
  private endpoint: QmdProxyEndpoint | null = null

  constructor(options: QmdProxyOptions) {
    this.service = options.service
    const host = options.host ?? '127.0.0.1'
    if (host !== '127.0.0.1' && host !== '::1') throw new Error('Knowledge proxy must bind to loopback')
    this.host = host
    this.portProvider = options.portProvider ?? (async () => 0)
    this.maxQueryLength = options.maxQueryLength ?? 2000
    this.maxTopK = options.maxTopK ?? 8
    this.maxBodyBytes = options.maxBodyBytes ?? 128 * 1024
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES
    this.maxDocumentLines = options.maxDocumentLines ?? 80
    this.docidTtlMs = options.handleTtlMs ?? 30 * 60 * 1000
    this.maxDocids = options.maxHandles ?? 1024
    this.now = options.now ?? (() => Date.now())
    this.token = options.token ?? randomBytes(32).toString('hex')
  }

  async start(): Promise<QmdProxyEndpoint> {
    if (this.endpoint && this.server) return this.endpoint
    const requestedPort = await this.portProvider()
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(requestedPort, this.host, () => resolve())
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : requestedPort
    if (!port) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error('Unable to allocate a loopback port for knowledge proxy')
    }
    this.server = server
    const formattedHost = this.host.includes(':') ? `[${this.host}]` : this.host
    this.endpoint = { url: `http://${formattedHost}:${port}`, token: this.token }
    return this.endpoint
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.endpoint = null
    this.issuedDocids.clear()
    if (!server) return
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  invalidateHandles(): void {
    this.issuedDocids.clear()
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? ''
    const prefix = 'Bearer '
    if (!header.startsWith(prefix)) return false
    const provided = Buffer.from(header.slice(prefix.length))
    const expected = Buffer.from(this.token)
    return provided.length === expected.length && timingSafeEqual(provided, expected)
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const lengthHeader = request.headers['content-length']
    const length = typeof lengthHeader === 'string' ? Number(lengthHeader) : 0
    if (Number.isFinite(length) && length > this.maxBodyBytes) {
      throw new KnowledgeError('invalid_request', 'Knowledge request body is too large')
    }
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > this.maxBodyBytes) throw new KnowledgeError('invalid_request', 'Knowledge request body is too large')
      chunks.push(buffer)
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      return parsed as Record<string, unknown>
    } catch {
      throw new KnowledgeError('invalid_request', 'Knowledge request body is invalid')
    }
  }

  private send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
    let payload = JSON.stringify(body)
    if (Buffer.byteLength(payload, 'utf8') > this.maxResponseBytes) {
      status = 503
      payload = JSON.stringify({
        status: 'error',
        code: 'proxy_unavailable',
        message: 'Knowledge response is too large',
      })
    }
    if (Buffer.byteLength(payload, 'utf8') > this.maxResponseBytes) {
      payload = JSON.stringify({ status: 'error', code: 'proxy_unavailable' })
    }
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Content-Length', Buffer.byteLength(payload, 'utf8'))
    response.end(payload)
  }

  private async readyForSearch(): Promise<void> {
    const snapshot = await this.service.snapshot()
    const name = snapshot.state.name
    if (name === 'no_collection') throw new KnowledgeError('no_collection', 'Knowledge collection is not configured')
    if (name === 'indexing' || name === 'downloading' || name === 'installing' || name === 'needs_consent') {
      throw new KnowledgeError('knowledge_indexing', 'Knowledge index is not ready')
    }
    if (name !== 'ready_vec' && name !== 'ready_hybrid') {
      throw new KnowledgeError('knowledge_not_ready', 'Knowledge service is not ready')
    }
  }

  private rememberDocid(docid: string): void {
    if (!DOCID_PATTERN.test(docid)) return
    this.issuedDocids.set(docid, this.now() + this.docidTtlMs)
    while (this.issuedDocids.size > this.maxDocids) {
      const oldest = this.issuedDocids.keys().next().value
      if (typeof oldest !== 'string') break
      this.issuedDocids.delete(oldest)
    }
  }

  private takeDocid(docid: string): boolean {
    if (!DOCID_PATTERN.test(docid)) return false
    const expiresAt = this.issuedDocids.get(docid)
    if (expiresAt === undefined || expiresAt <= this.now()) {
      this.issuedDocids.delete(docid)
      return false
    }
    return true
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.authorized(request)) {
        this.send(response, 401, { status: 'error', code: 'unauthorized', message: 'Unauthorized' })
        return
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname === '/v1/health' && request.method === 'GET') {
        const snapshot = await this.service.snapshot()
        this.send(response, 200, {
          status: 'ok',
          state: snapshot.state.name,
          collections: snapshot.collections.filter((collection) => collection.enabled).length,
        })
        return
      }
      if (url.pathname === '/v1/search' && request.method === 'POST') {
        const body = await this.readJson(request)
        const query = typeof body.query === 'string' ? body.query.trim() : ''
        const collectionId = body.collection_id === undefined
          ? undefined
          : typeof body.collection_id === 'string' && /^col_[a-f0-9]{32}$/.test(body.collection_id)
            ? body.collection_id
            : null
        const topK = body.top_k === undefined ? 5 : typeof body.top_k === 'number' ? body.top_k : Number.NaN
        if (!query || query.length > this.maxQueryLength || collectionId === null || !Number.isInteger(topK) || topK < 1 || topK > this.maxTopK) {
          throw new KnowledgeError('invalid_request', 'Knowledge search request is invalid')
        }
        await this.readyForSearch()
        const hits = (await this.service.search(query, collectionId, topK)).filter((hit) =>
          DOCID_PATTERN.test(hit.docid) && hasPublicCollectionName(hit.collectionName) && hasPublicRelativeFile(hit.relativeFile))
        hits.forEach((hit) => this.rememberDocid(hit.docid))
        this.send(response, 200, {
          status: hits.length > 0 ? 'ok' : 'no_results',
          results: hits.map((hit) => ({
            docid: hit.docid,
            title: publicTitle(hit.title, hit.relativeFile),
            source: `${hit.collectionName}/${hit.relativeFile}`,
            score: hit.score,
            snippet: hit.snippet,
            ...(hit.line !== undefined ? { line: hit.line } : {}),
          })),
        })
        return
      }
      if (url.pathname === '/v1/document' && request.method === 'POST') {
        const body = await this.readJson(request)
        const docid = typeof body.docid === 'string' ? body.docid : ''
        const startLine = body.start_line === undefined ? 1 : typeof body.start_line === 'number' ? body.start_line : Number.NaN
        const endLine = body.end_line === undefined ? startLine + this.maxDocumentLines - 1 : typeof body.end_line === 'number' ? body.end_line : Number.NaN
        if (
          !Number.isInteger(startLine) || !Number.isInteger(endLine) ||
          startLine < 1 || endLine < startLine || endLine - startLine + 1 > this.maxDocumentLines
        ) {
          throw new KnowledgeError('invalid_request', 'Knowledge document range is invalid')
        }
        if (!this.takeDocid(docid)) {
          throw new KnowledgeError('document_not_allowed', 'Document id is not allowed')
        }
        const document = await this.service.getDocument(docid, { startLine, endLine })
        if (!DOCID_PATTERN.test(document.docid) || document.docid !== docid ||
          !hasPublicCollectionName(document.collectionName) || !hasPublicRelativeFile(document.relativeFile)) {
          throw new KnowledgeError('document_not_allowed', 'Document id is not allowed')
        }
        const documentResponse = {
          status: 'ok',
          docid: document.docid,
          title: publicTitle(document.title, document.relativeFile),
          source: `${document.collectionName}/${document.relativeFile}`,
          content: '',
        }
        documentResponse.content = fitDocumentContent(documentResponse, document.content, this.maxResponseBytes)
        this.send(response, 200, documentResponse)
        return
      }
      this.send(response, 404, { status: 'error', code: 'not_found', message: 'Not found' })
    } catch (error) {
      if (error instanceof KnowledgeError) {
        this.send(response, statusForError(error.code), {
          status: 'error',
          code: error.code,
          message: defaultErrorMessage(error.code),
        })
        return
      }
      this.send(response, 503, { status: 'error', code: 'proxy_unavailable', message: defaultErrorMessage('proxy_unavailable') })
    }
  }
}
