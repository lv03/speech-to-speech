# Patches applied to the vendored QMD bundle

## `qmd-embed-route.patch`

Adds `POST /embed` to QMD's HTTP server so the memory backend can reuse the
embedding model QMD already has loaded, instead of loading a second copy.

- Target: `node_modules/@tobilu/qmd/dist/mcp/server.js` (QMD 2.8.3)
- Apply: `patch -p1 -d desktop < desktop/patches/qmd-embed-route.patch`
  (or `git apply` from the repository root)
- Verify after applying: start the daemon and `POST /embed {"texts":["x"],"isQuery":true}`
  must return a 1024-dim vector; measure per-call latency (~25 ms warm).
- Re-check on every QMD upgrade: the route depends on `getDefaultLlamaCpp`,
  `resolveEmbedModel`, `formatQueryForEmbedding` and `formatDocForEmbedding`
  being exported from `dist/llm.js`, and on the `/mcp` route staying in the same
  request handler.

See `experiments/voicemem/EMBEDDER.md` for the measurements and the alternative
(in-process llama.cpp) if this dependency is unacceptable.
