### Task 4：QmdMcpClient、QmdService 和 QmdProxy

**Files**

- Create: `desktop/src/main/qmd-mcp-client.ts`, `desktop/src/main/qmd-service.ts`, `desktop/src/main/qmd-proxy.ts`
- Modify: `desktop/src/main/runtime-types.ts`
- Test: `desktop/tests/qmd-mcp-client.test.mjs`, `desktop/tests/qmd-service.test.mjs`, `desktop/tests/qmd-proxy-contract.test.mjs`

**Interfaces**

```typescript
export interface QmdMcpClient {
  initialize(): Promise<{ version: string }>
  query(query: string, collection: string, limit: number): Promise<QmdSearchResult[]>
  get(docid: string, startLine: number, maxLines: number): Promise<string>
  status(): Promise<QmdStatus>
}

export class QmdService {
  addCollection(root: string, displayName?: string): Promise<CollectionRecord>
  removeCollection(collectionId: string): Promise<void>
  reindex(collectionId: string): Promise<void>
  deleteIndex(collectionId: string): Promise<void>
  search(query: string, collectionId?: string, topK?: number): Promise<KnowledgeSearchHit[]>
  getDocument(handle: string, range: LineRange): Promise<KnowledgeDocument>
  snapshot(): Promise<KnowledgeSnapshot>
}

export class QmdProxy {
  start(): Promise<{ url: string; token: string }>
  stop(): Promise<void>
}
```

MCP adapter 必须发送 2025-06-18 `initialize`，解析 SSE data line；QMD 2.8.3 没有 session header 也算成功，若返回 header 则保存并带回后续请求。只允许 `tools/call` 的 `query`、`get`、`status`；query 走 vec-only `searches`，get 只带内部 handle 映射出的 QMD docid。

QmdService 保存 app collection metadata 和单写者队列；QmdProxy 执行 token、body、参数、状态、handle、TTL、容量和响应截断检查。health 只能返回脱敏 public snapshot。`deleteIndex` 只移除 QMD collection 的索引数据并把 metadata 置为 pending，绝不删除用户源文件；重新索引时重新执行固定的 collection add/update/embed。

**安全验收**

```bash
npm --prefix desktop test -- tests/qmd-mcp-client.test.mjs \
  tests/qmd-service.test.mjs tests/qmd-proxy-contract.test.mjs
```

必须覆盖错误 token、任意 route/MCP method、query/top_k 越界、no collection、indexing、daemon 不可达、重复目录、未知/过期 handle、路径穿越、NUL、符号链接越界、QMD SSE 无 session header、绝对路径不外泄和 64 KiB 截断。

