#!/usr/bin/env node
// 生成"hybrid 批准版"运行时 manifest（本地/开发/E2E 用，未签名）。
// 在现有 build/runtime-manifest.json（staging 基线，含 python-runtime/wheelhouse/qmd/embedding）
// 基础上：批准 ['vec-only','hybrid']，补 reranker + generator 模型资产。
// 模型 sha256 取自本机 qmd 缓存（与镜像字节一致，embedding 已在 staging 验证同一文件）。
// 用法: node scripts/make-hybrid-manifest.mjs   → 输出 build/runtime-manifest.hybrid.json
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptRoot = resolve(__dirname, '..')
const sourceManifest = process.env.SOURCE_MANIFEST || join(scriptRoot, 'build', 'runtime-manifest.json')
const outputManifest = process.env.OUTPUT_MANIFEST || join(scriptRoot, 'build', 'runtime-manifest.hybrid.json')

const RERANKER = {
  id: 'reranker',
  kind: 'model',
  install: 'userData',
  version: 'qwen3-reranker-0.6b-q8_0',
  role: 'reranker',
  url: 'https://hf-mirror.com/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/main/qwen3-reranker-0.6b-q8_0.gguf',
}
const GENERATOR = {
  id: 'generator',
  kind: 'model',
  install: 'userData',
  version: 'qmd-query-expansion-1.7b-q4_k_m',
  role: 'generator',
  url: 'https://hf-mirror.com/tobil/qmd-query-expansion-1.7B-gguf/resolve/main/qmd-query-expansion-1.7B-q4_k_m.gguf',
}

// 本机 qmd 缓存中与上述镜像同字节的模型文件（sha256 一致才可写库）
const CACHE_CANDIDATES = {
  reranker: [
    process.env.RERANKER_GGUF,
    join(process.env.HOME || '', '.cache/qmd/models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf'),
  ].filter(Boolean),
  generator: [
    process.env.GENERATOR_GGUF,
    join(process.env.HOME || '', '.cache/qmd/models/hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf'),
  ].filter(Boolean),
}

async function sha256Of(path) {
  const buffer = await readFile(path)
  return createHash('sha256').update(buffer).digest('hex')
}

async function sizeOf(path) {
  return (await stat(path)).size
}

async function findLocalModel(key, spec) {
  for (const candidate of CACHE_CANDIDATES[key]) {
    try {
      const sha256 = await sha256Of(candidate)
      const size = await sizeOf(candidate)
      console.log(`[${key}] using ${candidate} (${size} bytes, sha ${sha256.slice(0, 12)}…)`)
      return { ...spec, sha256, size }
    } catch {
      // try next candidate
    }
  }
  throw new Error(`找不到 ${key} 模型文件，请设 ${key.toUpperCase()}_GGUF 指向 qmd 缓存中的 GGUF`)
}

async function main() {
  const base = JSON.parse(await readFile(sourceManifest, 'utf8'))
  const kept = base.assets.filter((asset) => asset.kind !== 'model' || asset.id === 'embedding')
  const embedding = kept.find((asset) => asset.id === 'embedding')
  if (!embedding) throw new Error('源 manifest 缺少 embedding 模型资产')
  const reranker = await findLocalModel('reranker', RERANKER)
  const generator = await findLocalModel('generator', GENERATOR)
  const manifest = {
    ...base,
    approvedProfiles: ['vec-only', 'hybrid'],
    assets: [...kept, reranker, generator],
  }
  await mkdir(dirname(outputManifest), { recursive: true })
  await writeFile(outputManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  console.log(`✓ 已写入 ${outputManifest}`)
  console.log('  approvedProfiles:', manifest.approvedProfiles.join(', '))
  console.log('  model assets:', manifest.assets.filter((a) => a.kind === 'model').map((a) => `${a.id}(${a.role})`).join(' '))
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
