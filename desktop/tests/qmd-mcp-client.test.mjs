import { expect, test } from 'vitest'

import { QmdMcpClient } from '../src/main/qmd-mcp-client'

function sse(result, headers = {}) {
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'test', result })}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

test('initializes QMD 2.8.3 from SSE without requiring a session header', async () => {
  const requests = []
  const client = new QmdMcpClient({
    endpoint: 'http://[::1]:8321/mcp',
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push({ request, headers: new Headers(init.headers) })
      if (request.method === 'initialize') {
        return sse({
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'qmd', version: '2.8.3' },
        })
      }
      if (request.params.name === 'query') {
        return sse({ structuredContent: { results: [{
          docid: '#internal-docid',
          file: 'safe.md',
          title: 'Safe',
          score: 0.8,
          snippet: 'hit',
          line: 3,
        }] } })
      }
      if (request.params.name === 'get') {
        return sse({ content: [{ type: 'resource', resource: { text: 'body' } }] })
      }
      return sse({ structuredContent: {
        totalDocuments: 2,
        needsEmbedding: 0,
        hasVectorIndex: true,
        collections: [{ name: 'kb_col', path: '/private/notes', documents: 2 }],
      } })
    },
  })

  await expect(client.initialize()).resolves.toEqual({ version: '2.8.3' })
  await expect(client.query('hello', 'kb_col', 5)).resolves.toEqual([
    expect.objectContaining({ docid: '#internal-docid', file: 'safe.md' }),
  ])
  await expect(client.get('#internal-docid', 2, 10)).resolves.toBe('body')
  await expect(client.status()).resolves.toEqual({
    totalDocuments: 2,
    needsEmbedding: 0,
    hasVectorIndex: true,
    collections: [{ name: 'kb_col', documents: 2 }],
  })

  expect(requests.map(({ request }) => request.method)).toEqual([
    'initialize',
    'tools/call',
    'tools/call',
    'tools/call',
  ])
  expect(requests[0].request.params.protocolVersion).toBe('2025-06-18')
  expect(requests[1].request.params).toEqual({
    name: 'query',
    arguments: {
      searches: [{ type: 'vec', query: 'hello' }],
      collections: ['kb_col'],
      limit: 5,
      rerank: false,
    },
  })
  expect(requests[2].request.params).toEqual({
    name: 'get',
    arguments: { file: '#internal-docid', fromLine: 2, maxLines: 10, lineNumbers: false },
  })
  expect(requests[3].request.params).toEqual({ name: 'status', arguments: {} })
  expect(requests.every(({ headers }) => headers.get('mcp-session-id') === null)).toBe(true)
})

test('stores an MCP session header and sends it on later allowlisted tool calls', async () => {
  const headers = []
  const client = new QmdMcpClient({
    endpoint: 'http://[::1]:8321/mcp',
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body)
      headers.push(new Headers(init.headers))
      if (request.method === 'initialize') {
        return sse({ protocolVersion: '2025-06-18', serverInfo: { name: 'qmd', version: '2.8.3' } }, {
          'mcp-session-id': 'session-123',
        })
      }
      return sse({ structuredContent: { results: [] } })
    },
  })

  await client.query('hello', 'kb_col', 1)

  expect(headers[0].get('mcp-session-id')).toBeNull()
  expect(headers[1].get('mcp-session-id')).toBe('session-123')
})

test('reset starts a new MCP generation without reusing initialization or session state', async () => {
  const requests = []
  const client = new QmdMcpClient({
    endpoint: 'http://[::1]:8321/mcp',
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push({ request, headers: new Headers(init.headers) })
      if (request.method === 'initialize') {
        return sse({ protocolVersion: '2025-06-18', serverInfo: { name: 'qmd', version: '2.8.3' } }, {
          'mcp-session-id': `session-${requests.filter(({ request: item }) => item.method === 'initialize').length}`,
        })
      }
      return sse({ structuredContent: { results: [] } })
    },
  })

  await client.query('before reset', 'kb_col', 1)
  client.reset()
  await client.query('after reset', 'kb_col', 1)

  expect(requests.filter(({ request }) => request.method === 'initialize')).toHaveLength(2)
  expect(requests[2].headers.get('mcp-session-id')).toBeNull()
  expect(requests[3].headers.get('mcp-session-id')).toBe('session-2')
})

test('maps unreachable QMD to a sanitized availability error', async () => {
  const client = new QmdMcpClient({
    endpoint: 'http://[::1]:8321/mcp',
    fetch: async () => { throw new Error('/Users/private/index.sqlite refused connection') },
  })

  await expect(client.initialize()).rejects.toMatchObject({
    code: 'proxy_unavailable',
    message: 'Knowledge service is unavailable',
  })
})

test('rejects non-loopback MCP endpoints before making a request', async () => {
  const client = new QmdMcpClient({
    endpoint: 'http://localhost:8321/mcp',
    fetch: async () => { throw new Error('network must not be used') },
  })

  await expect(client.initialize()).rejects.toMatchObject({
    code: 'proxy_unavailable',
    message: 'Knowledge service is unavailable',
  })
})
