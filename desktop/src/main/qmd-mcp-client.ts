import { randomBytes } from 'node:crypto'

import { KnowledgeError } from './qmd-service'
import type { QmdSearchResult, QmdStatus, RetrievalMode } from './runtime-types'

export interface QmdMcpClientOptions {
  endpoint: string | (() => string)
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface QmdClient {
  reset(): void
  initialize(): Promise<{ version: string }>
  query(query: string, collection: string, limit: number, mode?: RetrievalMode): Promise<QmdSearchResult[]>
  get(docid: string, startLine: number, maxLines: number): Promise<string>
  status(): Promise<QmdStatus>
}

interface McpResult {
  structuredContent?: unknown
  content?: Array<{ type?: unknown; text?: unknown; resource?: { text?: unknown } }>
  protocolVersion?: unknown
  serverInfo?: { name?: unknown; version?: unknown }
}

interface McpEnvelope {
  result?: McpResult
  error?: { message?: unknown }
}

function parseSse(body: string): McpEnvelope {
  const messages: string[] = []
  let dataLines: string[] = []
  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      if (dataLines.length > 0) messages.push(dataLines.join('\n'))
      dataLines = []
      continue
    }
    if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart())
  }
  if (dataLines.length > 0) messages.push(dataLines.join('\n'))
  const raw = messages.at(-1) || body.trim()
  if (!raw) throw new Error('QMD MCP returned an empty response')
  return JSON.parse(raw) as McpEnvelope
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function resultPayload(result: McpResult | undefined): unknown {
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = result?.content?.find((item) => typeof item.text === 'string')?.text
  if (typeof text === 'string') {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  return undefined
}

function resultText(result: McpResult | undefined): string | undefined {
  const resource = result?.content?.find((item) => item.type === 'resource')?.resource?.text
  if (typeof resource === 'string') return resource
  const text = result?.content?.find((item) => typeof item.text === 'string')?.text
  return typeof text === 'string' ? text : undefined
}

function searchResults(value: unknown): QmdSearchResult[] {
  const record = asRecord(value)
  const items = Array.isArray(value) ? value : record?.results
  if (!Array.isArray(items)) return []
  return items.flatMap((item): QmdSearchResult[] => {
    const raw = asRecord(item)
    if (!raw || typeof raw.docid !== 'string' || typeof raw.file !== 'string') return []
    const score = typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : 0
    return [{
      docid: raw.docid,
      file: raw.file,
      title: typeof raw.title === 'string' && raw.title ? raw.title : raw.file,
      score,
      snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
      ...(typeof raw.line === 'number' && Number.isInteger(raw.line) && raw.line > 0 ? { line: raw.line } : {}),
    }]
  })
}

function qmdStatus(value: unknown): QmdStatus {
  const raw = asRecord(value)
  if (!raw || typeof raw.totalDocuments !== 'number' || typeof raw.needsEmbedding !== 'number' || typeof raw.hasVectorIndex !== 'boolean') {
    throw new Error('QMD MCP returned an invalid status')
  }
  const collections = Array.isArray(raw.collections)
    ? raw.collections.flatMap((item) => {
      const collection = asRecord(item)
      if (!collection || typeof collection.name !== 'string' || typeof collection.documents !== 'number') return []
      return [{ name: collection.name, documents: collection.documents }]
    })
    : []
  return {
    totalDocuments: raw.totalDocuments,
    needsEmbedding: raw.needsEmbedding,
    hasVectorIndex: raw.hasVectorIndex,
    collections,
  }
}

export class QmdMcpClient implements QmdClient {
  private readonly endpoint: string | (() => string)
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private sessionId: string | null = null
  private initializePromise: Promise<{ version: string }> | null = null
  private generation = 0

  constructor(options: QmdMcpClientOptions) {
    this.endpoint = options.endpoint
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  reset(): void {
    this.generation += 1
    this.initializePromise = null
    this.sessionId = null
  }

  private url(): string {
    const value = typeof this.endpoint === 'function' ? this.endpoint() : this.endpoint
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
    }
    if (!['127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== '/mcp') {
      throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
    }
    return parsed.href
  }

  private async post(body: Record<string, unknown>): Promise<McpEnvelope> {
    const generation = this.generation
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      }
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
      const response = await this.fetchImpl(this.url(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) throw new Error(`QMD MCP HTTP ${response.status}`)
      const sessionId = response.headers.get('mcp-session-id')
      if (sessionId && generation === this.generation) this.sessionId = sessionId
      const envelope = parseSse(await response.text())
      if (envelope.error) throw new Error(typeof envelope.error.message === 'string' ? envelope.error.message : 'QMD MCP error')
      return envelope
    } catch (error) {
      if (error instanceof KnowledgeError) throw error
      throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
    }
  }

  async initialize(): Promise<{ version: string }> {
    if (this.initializePromise) return this.initializePromise
    const generation = this.generation
    const promise = this.post({
      jsonrpc: '2.0',
      id: `speech-to-speech-${randomBytes(8).toString('hex')}`,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'speech-to-speech', version: '0.1.0' },
      },
    }).then((envelope) => {
      const version = envelope.result?.serverInfo?.version
      if (
        envelope.result?.protocolVersion !== '2025-06-18' ||
        envelope.result.serverInfo?.name !== 'qmd' ||
        typeof version !== 'string'
      ) {
        throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
      }
      return { version }
    }).catch((error) => {
      if (generation === this.generation && this.initializePromise === promise) {
        this.initializePromise = null
      }
      throw error
    })
    this.initializePromise = promise
    return promise
  }

  private async callTool(name: 'query' | 'get' | 'status', arguments_: Record<string, unknown>): Promise<McpResult | undefined> {
    await this.initialize()
    const envelope = await this.post({
      jsonrpc: '2.0',
      id: `speech-to-speech-${randomBytes(8).toString('hex')}`,
      method: 'tools/call',
      params: { name, arguments: arguments_ },
    })
    return envelope.result
  }

  /**
   * Execute a retrieval in the requested mode:
   *  - 'vec-only': vector search only (no rerank)
   *  - 'hybrid': typed lex+vec sub-queries with rerank (no internal query expansion)
   *  - 'full': plain-text query so QMD runs its complete pipeline (query
   *    expansion to lex/vec/hyde + RRF + rerank)
   */
  async query(query: string, collection: string, limit: number, mode: RetrievalMode = 'vec-only'): Promise<QmdSearchResult[]> {
    let result
    if (mode === 'vec-only') {
      result = await this.callTool('query', {
        searches: [{ type: 'vec', query }],
        collections: [collection],
        limit,
        rerank: false,
      })
    } else if (mode === 'full') {
      result = await this.callTool('query', {
        query,
        collections: [collection],
        limit,
        rerank: true,
      })
    } else {
      result = await this.callTool('query', {
        searches: [{ type: 'lex', query }, { type: 'vec', query }],
        collections: [collection],
        limit,
        rerank: true,
      })
    }
    return searchResults(resultPayload(result))
  }

  async get(docid: string, startLine: number, maxLines: number): Promise<string> {
    const result = await this.callTool('get', {
      file: docid,
      fromLine: startLine,
      maxLines,
      lineNumbers: false,
    })
    const content = resultText(result)
    if (content === undefined) throw new KnowledgeError('proxy_unavailable', 'Knowledge service is unavailable')
    return content
  }

  async status(): Promise<QmdStatus> {
    const result = await this.callTool('status', {})
    return qmdStatus(resultPayload(result))
  }
}
