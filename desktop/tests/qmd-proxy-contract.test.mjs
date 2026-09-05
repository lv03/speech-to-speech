import { Buffer } from 'node:buffer'
import { expect, test } from 'vitest'

import { QmdProxy } from '../src/main/qmd-proxy'
import { KnowledgeError } from '../src/main/qmd-service'

const HANDLE = `doc_${'1'.repeat(64)}`

function service(overrides = {}) {
  return {
    snapshot: async () => ({
      state: { name: 'ready_vec', updatedAt: '2026-09-05T00:00:00.000Z' },
      collections: [{
        collectionId: 'col_123',
        displayName: 'Notes',
        root: '/Users/private/secret-notes',
        include: '**/*.md',
        enabled: true,
        lastIndexedAt: null,
        indexState: 'ready',
      }],
    }),
    search: async () => [{
      handle: HANDLE,
      collectionId: 'col_123',
      collectionName: 'Notes',
      relativeFile: 'safe.md',
      title: 'Safe note',
      score: 0.81,
      snippet: 'safe snippet',
    }],
    getDocument: async (handle) => ({
      handle,
      collectionName: 'Notes',
      relativeFile: 'safe.md',
      title: 'Safe note',
      content: 'trusted content',
    }),
    ...overrides,
  }
}

async function withProxy(options, run) {
  const proxy = new QmdProxy({ service: service(), portProvider: async () => 0, ...options })
  const endpoint = await proxy.start()
  try {
    await run(endpoint)
  } finally {
    await proxy.stop()
  }
}

function headers(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

test('requires the bearer token and rejects arbitrary routes, methods, and MCP payloads', async () => {
  await withProxy({}, async ({ url, token }) => {
    const noToken = await fetch(`${url}/v1/search`, { method: 'POST', body: '{}' })
    expect(noToken.status).toBe(401)

    const wrongToken = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: headers('wrong'),
      body: JSON.stringify({ query: 'hello' }),
    })
    expect(wrongToken.status).toBe(401)

    for (const [path, method, body] of [
      ['/mcp', 'POST', { method: 'tools/call', params: { name: 'multi_get' } }],
      ['/v1/search', 'PUT', { query: 'hello' }],
      ['/v1/arbitrary', 'POST', { query: 'hello' }],
    ]) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: headers(token),
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(404)
    }
  })
})

test('enforces body, query, top_k, and document range limits before delegation', async () => {
  let searches = 0
  let documents = 0
  await withProxy({
    service: service({
      search: async () => { searches += 1; return [] },
      getDocument: async () => { documents += 1; throw new Error('must not run') },
    }),
    maxBodyBytes: 40,
    maxQueryLength: 10,
    maxTopK: 2,
    maxDocumentLines: 3,
  }, async ({ url, token }) => {
    const requestHeaders = headers(token)
    const invalidSearches = [
      { query: '' },
      { query: '01234567890' },
      { query: 'ok', top_k: 0 },
      { query: 'ok', top_k: 3 },
      { query: 'ok', top_k: 1.5 },
    ]
    for (const body of invalidSearches) {
      const response = await fetch(`${url}/v1/search`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })
      expect(response.status).toBe(400)
    }
    const oversized = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ query: 'x'.repeat(80) }),
    })
    expect(oversized.status).toBe(400)
    const malformed = await fetch(`${url}/v1/search`, { method: 'POST', headers: requestHeaders, body: '{' })
    expect(malformed.status).toBe(400)
    expect(searches).toBe(0)
    expect(documents).toBe(0)
  })
})

test('checks no-collection and indexing states before search and sanitizes daemon failures', async () => {
  for (const [state, code] of [['no_collection', 'no_collection'], ['indexing', 'knowledge_indexing']]) {
    let searches = 0
    await withProxy({
      service: service({
        snapshot: async () => ({ state: { name: state, updatedAt: '/private/time' }, collections: [] }),
        search: async () => { searches += 1; return [] },
      }),
    }, async ({ url, token }) => {
      const response = await fetch(`${url}/v1/search`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ query: 'hello' }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ status: 'error', code, message: expect.any(String) })
      expect(searches).toBe(0)
    })
  }

  await withProxy({
    service: service({ search: async () => { throw new Error('/Users/private/qmd.sock failed') } }),
  }, async ({ url, token }) => {
    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ query: 'hello' }),
    })
    expect(response.status).toBe(503)
    const body = await response.text()
    expect(body).toContain('proxy_unavailable')
    expect(body).not.toContain('/Users/private')
  })
})

test('uses only opaque handles and rejects unknown, expired, and capacity-evicted handles', async () => {
  let now = 1_000
  let nextHandle = 1
  const handles = () => `doc_${String(nextHandle++).padStart(64, '0')}`
  await withProxy({
    now: () => now,
    handleTtlMs: 10,
    maxHandles: 1,
    service: service({
      search: async () => [{
        handle: handles(), collectionId: 'col', collectionName: 'Notes', relativeFile: 'safe.md',
        title: 'Safe', score: 1, snippet: '',
      }],
    }),
  }, async ({ url, token }) => {
    const requestHeaders = headers(token)
    const search = async () => (await (await fetch(`${url}/v1/search`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ query: 'hello' }),
    })).json()).results[0].handle
    const first = await search()
    const second = await search()

    expect(first).toMatch(/^doc_[a-f0-9]{64}$/)
    expect(second).not.toBe(first)
    for (const handle of [first, '#qmd-docid', '/etc/passwd', '../safe.md', 'safe.md\0x']) {
      const response = await fetch(`${url}/v1/document`, {
        method: 'POST', headers: requestHeaders, body: JSON.stringify({ handle }),
      })
      expect(response.status).toBe(403)
    }
    now += 11
    const expired = await fetch(`${url}/v1/document`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ handle: second }),
    })
    expect(expired.status).toBe(403)
  })
})

test('returns sanitized health and never leaks absolute paths in public responses', async () => {
  await withProxy({}, async ({ url, token }) => {
    const response = await fetch(`${url}/v1/health`, { headers: headers(token) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', state: 'ready_vec', collections: 1 })
  })
})

test('filters path-like collection names and non-opaque handles at the public boundary', async () => {
  await withProxy({
    service: service({
      search: async () => [{
        handle: '#qmd-docid',
        collectionId: 'col_123',
        collectionName: '/Users/private/notes',
        relativeFile: 'safe.md',
        title: 'Safe',
        score: 1,
        snippet: 'safe',
      }],
    }),
  }, async ({ url, token }) => {
    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ query: 'hello' }),
    })
    const body = await response.text()
    expect(body).not.toContain('/Users/private/notes')
    expect(body).not.toContain('#qmd-docid')
    expect(JSON.parse(body)).toMatchObject({ status: 'no_results', results: [] })
  })
})

test('rejects dot-segment collection names in search and document responses', async () => {
  await withProxy({
    service: service({
      search: async () => [{
        handle: HANDLE,
        collectionId: 'col_123',
        collectionName: '..',
        relativeFile: 'safe.md',
        title: 'Safe',
        score: 1,
        snippet: 'safe',
      }],
    }),
  }, async ({ url, token }) => {
    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ query: 'hello' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'no_results', results: [] })
  })

  await withProxy({
    service: service({
      getDocument: async (handle) => ({
        handle,
        collectionName: '.',
        relativeFile: 'safe.md',
        title: 'Safe',
        content: 'trusted content',
      }),
    }),
  }, async ({ url, token }) => {
    const requestHeaders = headers(token)
    const search = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ query: 'hello' }),
    })
    const handle = (await search.json()).results[0].handle
    const response = await fetch(`${url}/v1/document`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ handle }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'document_not_allowed' })
  })
})

test('truncates document content to at most 64 KiB without corrupting UTF-8', async () => {
  const content = '你'.repeat(30_000)
  await withProxy({
    service: service({
      getDocument: async (handle) => ({
        handle,
        collectionName: 'Notes',
        relativeFile: 'safe.md',
        title: 'Safe',
        content,
      }),
    }),
  }, async ({ url, token }) => {
    const requestHeaders = headers(token)
    await fetch(`${url}/v1/search`, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ query: 'hello' }) })
    const response = await fetch(`${url}/v1/document`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ handle: HANDLE, start_line: 1, end_line: 80 }),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.handle).toBe(HANDLE)
    expect(body).not.toHaveProperty('docid')
    expect(Buffer.byteLength(body.content, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(body.content).not.toContain('\uFFFD')
  })
})

test('maps stable service errors without leaking their private messages', async () => {
  await withProxy({
    service: service({ search: async () => { throw new KnowledgeError('knowledge_not_ready', '/private/index missing') } }),
  }, async ({ url, token }) => {
    const response = await fetch(`${url}/v1/search`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ query: 'hello' }),
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      status: 'error', code: 'knowledge_not_ready', message: 'Knowledge base is not ready',
    })
  })
})
