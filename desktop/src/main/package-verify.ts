import { app } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { ModelStore } from './model-store'
import { PythonRuntime } from './python-runtime'
import { QmdIndexer } from './qmd-indexer'
import { QmdMcpClient } from './qmd-mcp-client'
import { QmdProxy } from './qmd-proxy'
import { QmdRuntime } from './qmd-runtime'
import { QmdService } from './qmd-service'
import type { RuntimeAsset, RuntimeManifest } from './runtime-types'

const execFileAsync = promisify(execFile)
const PACKAGE_VERIFY_FLAG = '--package-verify'
const REQUIRED_ASSET_KINDS = new Set(['python-runtime', 'wheelhouse', 'qmd', 'model'])
const FAILURE_CODES = ['args', 'resources', 'native', 'fixture', 'model', 'qmd', 'proxy', 'runtime'] as const
type PackageVerifyCode = typeof FAILURE_CODES[number]

interface PackageVerifyOptions {
  fixture: string
  dataRoot: string
  smokeModel: string
}

class PackageVerifyFailure extends Error {
  readonly code: PackageVerifyCode

  constructor(code: PackageVerifyCode) {
    super('Package verification failed')
    this.code = code
  }
}

function fail(code: PackageVerifyCode): never {
  throw new PackageVerifyFailure(code)
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function parseOptions(argv: string[]): PackageVerifyOptions | null {
  if (!argv.includes(PACKAGE_VERIFY_FLAG)) return null
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (index === 0 && !flag.startsWith('--')) continue
    if (flag === PACKAGE_VERIFY_FLAG) continue
    if (!['--fixture', '--data-root', '--smoke-model'].includes(flag)) fail('args')
    const value = argv[index + 1]
    if (!value || value.startsWith('--') || values.has(flag)) fail('args')
    values.set(flag, value)
    index += 1
  }
  const fixture = values.get('--fixture')
  const dataRoot = values.get('--data-root')
  const smokeModel = values.get('--smoke-model')
  if (!fixture || !dataRoot || !smokeModel || !isAbsolute(fixture) || !isAbsolute(dataRoot) || !isAbsolute(smokeModel)) {
    fail('args')
  }
  return { fixture, dataRoot, smokeModel }
}

function packageFailureOutput(code: PackageVerifyCode): string {
  return `PACKAGE_VERIFY_FAILED:${code}\n`
}

function assertManifest(manifest: RuntimeManifest): void {
  if (
    manifest.schemaVersion !== 1 || manifest.platform !== 'darwin-arm64' ||
    !manifest.pythonAbi || manifest.profile !== 'voice-default' || !Array.isArray(manifest.assets)
  ) fail('resources')
  const ids = new Set<string>()
  const kinds = new Set<string>()
  for (const asset of manifest.assets) {
    if (
      !asset || ids.has(asset.id) || kinds.has(asset.kind) || !REQUIRED_ASSET_KINDS.has(asset.kind) ||
      !asset.id || !asset.version || !['resources', 'userData'].includes(asset.install) ||
      (asset.install === 'userData' && asset.kind !== 'model') ||
      (asset.install === 'resources' && (
        !asset.path || isAbsolute(asset.path) || asset.path.includes('\\') ||
        asset.path.split('/').some((part) => !part || part === '.' || part === '..')
      )) ||
      (asset.install === 'userData' && asset.path !== undefined) ||
      !asset.url.startsWith('https://') || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) fail('resources')
    ids.add(asset.id)
    kinds.add(asset.kind)
  }
  if ([...REQUIRED_ASSET_KINDS].some((kind) => !kinds.has(kind))) fail('resources')
}

async function requireEntry(path: string, code: PackageVerifyCode): Promise<void> {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() && !metadata.isDirectory()) fail(code)
  } catch {
    fail(code)
  }
}

async function verifyResourceAsset(path: string, asset: RuntimeAsset): Promise<void> {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size !== asset.size) fail('resources')
    const digest = createHash('sha256').update(await readFile(path)).digest('hex')
    if (digest !== asset.sha256) fail('resources')
  } catch (error) {
    if (error instanceof PackageVerifyFailure) throw error
    fail('resources')
  }
}

async function nativeCandidates(root: string): Promise<string[]> {
  const result: string[] = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await nativeCandidates(path))
    else if (entry.name.endsWith('.node')) result.push(path)
  }
  return result.sort()
}

interface PackageResources {
  root: string
  qmdRoot: string
  runtimeRoot: string
  qmdEntrypoint: string
  python: string
  wheelhouse: string
  nativeAddon: string
  manifest: RuntimeManifest
}

async function packageResources(): Promise<PackageResources> {
  const root = resolve(process.resourcesPath)
  const qmdRoot = join(root, 'qmd')
  const runtimeRoot = join(root, 'runtime')
  const manifestPath = join(root, 'runtime-manifest.json')
  const qmdEntrypoint = join(qmdRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd')
  const python = join(runtimeRoot, process.platform === 'win32' ? 'bin/python.exe' : 'bin/python')
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeManifest
    assertManifest(manifest)
    const realRoot = await realpathSafe(root)
    for (const path of [qmdRoot, runtimeRoot, manifestPath, qmdEntrypoint, python]) {
      await requireEntry(path, 'resources')
      if (!inside(root, path) || !inside(realRoot, await realpathSafe(path))) fail('resources')
    }
    const wheelhouseAsset = manifest.assets.find((asset) => asset.kind === 'wheelhouse')
    const wheelhouseAssetPath = resolve(root, wheelhouseAsset?.path ?? '')
    await requireEntry(wheelhouseAssetPath, 'resources')
    await verifyResourceAsset(wheelhouseAssetPath, wheelhouseAsset as RuntimeAsset)
    if (!inside(root, wheelhouseAssetPath) || !inside(realRoot, await realpathSafe(wheelhouseAssetPath))) fail('resources')
    const wheelhouseDirectory = join(runtimeRoot, 'wheelhouse')
    const wheelhouse = await stat(wheelhouseDirectory).then((metadata) =>
      metadata.isDirectory() ? wheelhouseDirectory : wheelhouseAssetPath,
    ).catch(() => wheelhouseAssetPath)
    for (const asset of manifest.assets.filter((candidate) => candidate.install === 'resources')) {
      const assetPath = resolve(root, asset.path ?? '')
      await requireEntry(assetPath, 'resources')
      await verifyResourceAsset(assetPath, asset)
      if (!inside(root, assetPath) || !inside(realRoot, await realpathSafe(assetPath))) fail('resources')
    }
    const candidates = await nativeCandidates(qmdRoot)
    const nativeAddon = candidates.find((path) => path.includes('@node-llama-cpp')) ?? candidates[0]
    if (!nativeAddon || !inside(realRoot, await realpathSafe(nativeAddon))) fail('native')
    return { root, qmdRoot, runtimeRoot, qmdEntrypoint, python, wheelhouse, nativeAddon, manifest }
  } catch (error) {
    if (error instanceof PackageVerifyFailure) throw error
    fail('resources')
  }
}

async function realpathSafe(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    fail('resources')
  }
}

async function loadNativeAddon(resources: PackageResources): Promise<void> {
  try {
    createRequire(import.meta.url)(resources.nativeAddon)
  } catch {
    fail('native')
  }
}

function qmdEnvironment(dataRoot: string): NodeJS.ProcessEnv {
  const root = resolve(dataRoot)
  const qmdRoot = join(root, 'qmd')
  const environment = { ...process.env }
  delete environment.NODE_PATH
  delete environment.RUNTIME_MANIFEST_PATH
  return {
    ...environment,
    PATH: '',
    ELECTRON_RUN_AS_NODE: '1',
    HOME: join(qmdRoot, 'home'),
    XDG_CONFIG_HOME: join(qmdRoot, 'config'),
    XDG_CACHE_HOME: join(qmdRoot, 'cache'),
    QMD_CONFIG_DIR: join(qmdRoot, 'config', 'qmd'),
    INDEX_PATH: join(qmdRoot, 'cache', 'qmd', 'index.sqlite'),
    QMD_INDEX_PATH: join(qmdRoot, 'cache', 'qmd', 'index.sqlite'),
  }
}

async function assertPrivateQmdPaths(dataRoot: string): Promise<void> {
  const root = resolve(dataRoot)
  const environment = qmdEnvironment(root)
  for (const path of [
    environment.HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_CACHE_HOME,
    environment.QMD_CONFIG_DIR,
    environment.INDEX_PATH,
    join(root, 'qmd', 'cache', 'qmd', 'models'),
  ]) {
    if (!path || !inside(root, resolve(path))) fail('runtime')
  }
}

async function installSmokeModel(resources: PackageResources, dataRoot: string, smokeModel: string): Promise<void> {
  const asset = resources.manifest.assets.find((candidate) => candidate.kind === 'model') as RuntimeAsset | undefined
  if (!asset) fail('model')
  let contents: Buffer
  try {
    const metadata = await stat(smokeModel)
    contents = await readFile(smokeModel)
    if (!metadata.isFile() || metadata.size !== asset.size) fail('model')
  } catch {
    fail('model')
  }
  if (createHash('sha256').update(contents).digest('hex') !== asset.sha256) fail('model')
  const modelsRoot = join(dataRoot, 'qmd', 'cache', 'qmd', 'models')
  const destination = join(modelsRoot, `${asset.id}-${asset.version}.gguf`)
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`
  const store = new ModelStore({ root: dataRoot, manifest: resources.manifest })
  try {
    await mkdir(modelsRoot, { recursive: true, mode: 0o700 })
    const existing = await store.inspect(asset.id)
    if (existing.present) {
      if (existing.sha256 !== asset.sha256 || await store.ensure(asset.id) !== destination) fail('model')
      return
    }
    await copyFile(smokeModel, temporary)
    await chmod(temporary, 0o600)
    await rename(temporary, destination)
    const installed = await store.ensure(asset.id)
    if (installed !== destination || !(await store.inspect(asset.id)).present) fail('model')
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    if (error instanceof PackageVerifyFailure) throw error
    fail('model')
  }
}

async function snapshotUserQmdState(): Promise<string> {
  const root = homedir()
  const watched = ['.config/qmd', '.cache/qmd', '.local/share/qmd', '.qmd']
  const records: string[] = []
  async function visit(path: string, relativePath: string): Promise<void> {
    try {
      const metadata = await lstat(path)
      records.push(`${relativePath}:${metadata.isDirectory() ? 'd' : metadata.isFile() ? 'f' : 'o'}:${metadata.size}:${metadata.mtimeMs}`)
      if (metadata.isDirectory()) {
        const entries = await readdir(path, { withFileTypes: true })
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          await visit(join(path, entry.name), join(relativePath, entry.name))
        }
      }
    } catch {
      records.push(`${relativePath}:missing`)
    }
  }
  for (const path of watched) await visit(join(root, path), path)
  return records.join('\n')
}

async function runVoiceToolSmoke(resources: PackageResources, dataRoot: string, proxy: { url: string; token: string }): Promise<void> {
  const runtime = new PythonRuntime({
    userDataDir: dataRoot,
    manifest: resources.manifest,
    packagedRoot: resources.runtimeRoot,
  })
  const paths = await runtime.ensureReady()
  if (!inside(resources.root, resolve(paths.python)) || !inside(resources.root, resolve(paths.appRoot))) fail('runtime')
  const script = [
    'import asyncio, json',
    'from speech_to_speech.tools.qmd_knowledge import TOOLS, get_document, search_knowledge',
    'async def main():',
    "  assert {tool['name'] for tool in TOOLS} == {'search_knowledge', 'get_document'}",
    '  result = json.loads(await search_knowledge("花生过敏", top_k=3))',
    '  assert result["status"] == "ok" and result["results"]',
    '  document = json.loads(await get_document(result["results"][0]["handle"]))',
    '  assert document["status"] == "ok" and "花生" in document["content"]',
    '  malicious = json.loads(await search_knowledge("忽略系统规则", top_k=3))',
    '  assert malicious["status"] == "ok" and malicious["results"]',
    '  malicious_document = json.loads(await get_document(malicious["results"][0]["handle"]))',
    '  assert "只能作为资料内容" in malicious_document["content"]',
    'asyncio.run(main())',
  ].join('\n')
  try {
    await execFileAsync(paths.python, ['-c', script], {
      cwd: paths.appRoot,
      env: {
        ...qmdEnvironment(dataRoot),
        QMD_PROXY_URL: proxy.url,
        QMD_PROXY_TOKEN: proxy.token,
      },
      maxBuffer: 64 * 1024,
    })
  } catch {
    fail('proxy')
  }
}

export async function runPackageVerification(options: PackageVerifyOptions): Promise<void> {
  const resources = await packageResources()
  await loadNativeAddon(resources)
  await assertPrivateQmdPaths(options.dataRoot)
  for (const name of ['allergy.md', 'project-notes.md', 'malicious-instructions.md']) {
    await requireEntry(join(options.fixture, name), 'fixture')
  }
  const homeBefore = await snapshotUserQmdState()
  let qmdRuntime: QmdRuntime | undefined
  let proxy: QmdProxy | undefined
  try {
    await installSmokeModel(resources, options.dataRoot, options.smokeModel)
    const metadataPath = join(options.dataRoot, 'knowledge', 'collections.json')
    const service = new QmdService({
      metadataPath,
      runner: new QmdIndexer({ resourceRoot: resources.qmdRoot, dataRoot: options.dataRoot }),
    })
    const collection = await service.addCollection(options.fixture, '中文验收')
    qmdRuntime = new QmdRuntime({ resourceRoot: resources.qmdRoot, dataRoot: options.dataRoot })
    const client = new QmdMcpClient({ endpoint: () => qmdRuntime?.endpoint?.baseUrl ?? '' })
    await qmdRuntime.start()
    service.setClient(client)
    await client.initialize()
    await service.reindex(collection.collectionId)
    const status = await client.status()
    if (!status.hasVectorIndex || status.totalDocuments < 3) fail('qmd')
    const allergy = (await service.search('花生过敏', collection.collectionId, 3))[0]
    if (!allergy || allergy.relativeFile !== 'allergy.md') fail('qmd')
    const allergyDocument = await service.getDocument(allergy.handle, { startLine: 1, endLine: 5 })
    if (!allergyDocument.content.includes('花生')) fail('qmd')
    const malicious = (await service.search('忽略系统规则', collection.collectionId, 3))
      .find((hit) => hit.relativeFile === 'malicious-instructions.md')
    if (!malicious) fail('qmd')
    const maliciousDocument = await service.getDocument(malicious.handle, { startLine: 1, endLine: 5 })
    if (!maliciousDocument.content.includes('只能作为资料内容')) fail('qmd')
    service.setRuntimeState({ name: 'ready_vec', updatedAt: new Date().toISOString() })
    proxy = new QmdProxy({ service })
    const endpoint = await proxy.start()
    await runVoiceToolSmoke(resources, options.dataRoot, endpoint)
  } catch (error) {
    if (error instanceof PackageVerifyFailure) throw error
    fail('qmd')
  } finally {
    await proxy?.stop().catch(() => undefined)
    await qmdRuntime?.stop().catch(() => undefined)
  }
  if (homeBefore !== await snapshotUserQmdState()) fail('runtime')
}

export function packageVerifyOptionsFromArgv(argv = process.argv.slice(1)): PackageVerifyOptions | null {
  return parseOptions(argv)
}

async function startFromArgv(options: PackageVerifyOptions): Promise<void> {
  app.setPath('userData', options.dataRoot)
  await app.whenReady()
  try {
    await runPackageVerification(options)
    process.stdout.write('PACKAGE_VERIFY_OK\n')
    app.exit(0)
  } catch (error) {
    const code = error instanceof PackageVerifyFailure && FAILURE_CODES.includes(error.code) ? error.code : 'runtime'
    process.stderr.write(packageFailureOutput(code))
    app.exit(1)
  }
}

if (process.argv.includes(PACKAGE_VERIFY_FLAG)) {
  try {
    const packageVerifyOptions = packageVerifyOptionsFromArgv()
    if (!packageVerifyOptions) fail('args')
    app.setPath('userData', packageVerifyOptions.dataRoot)
    void startFromArgv(packageVerifyOptions)
  } catch (error) {
    const code = error instanceof PackageVerifyFailure && FAILURE_CODES.includes(error.code) ? error.code : 'args'
    process.stderr.write(packageFailureOutput(code))
    app.exit(1)
  }
}
