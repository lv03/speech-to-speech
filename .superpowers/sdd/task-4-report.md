# Task 4 Report: QMD MCP Client, Service, and Proxy

## Status

Completed on branch `feature/desktop-gateway`; final implementation is ready for task review.

## TDD Evidence

### RED

The focused Task 4 command was run before the production implementation:

```text
npm --prefix desktop run test:vitest -- tests/qmd-mcp-client.test.mjs tests/qmd-service.test.mjs tests/qmd-proxy-contract.test.mjs
```

It failed as expected because the separate MCP client was absent, service mutation/search/handle behavior was not implemented, and proxy still used the old docid contract.

### GREEN

After implementation and boundary hardening:

```text
npm --prefix desktop run test:vitest -- tests/qmd-mcp-client.test.mjs tests/qmd-service.test.mjs tests/qmd-proxy-contract.test.mjs
Result: PASS (3 files, 16 tests)

npm --prefix desktop run typecheck
Result: PASS
```

## Changed Files

- `desktop/src/main/runtime-types.ts`: shared QMD, public hit/document, line range, and snapshot types.
- `desktop/src/main/qmd-mcp-client.ts`: 2025-06-18 MCP initialize, SSE parsing, optional session propagation, vec-only query, get/status allowlist, and sanitized transport errors.
- `desktop/src/main/qmd-service.ts`: canonical collection roots, app metadata persistence, serialized mutation queue, QMD result validation, realpath/symlink containment checks, bounded expiring opaque handles, and document retrieval through the internal docid mapping.
- `desktop/src/main/qmd-proxy.ts`: loopback authenticated API, request validation, public health sanitization, handle allowlist, stable error mapping, and UTF-8-safe 64 KiB document truncation.
- `desktop/tests/qmd-mcp-client.test.mjs`, `desktop/tests/qmd-service.test.mjs`, `desktop/tests/qmd-proxy-contract.test.mjs`: MCP, indexing state, queue, path, handle, auth, privacy, error, and response contract tests.

## Self-Review

The public proxy never serializes QMD docids or collection roots. Both service and proxy validate handles; service revalidates realpath before QMD get and invalidates handles on collection removal, index deletion, and reindex. Collection names and public relative files are validated at both service and proxy boundaries. QMD SSE responses work with and without a session header. The proxy is restricted to loopback and the three documented routes. Full desktop and Python suites remain for the final integration gates after Tasks 5-8.
