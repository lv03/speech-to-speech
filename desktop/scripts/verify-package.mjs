import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SUPPORTED_PLATFORM = 'darwin-arm64'
const REQUIRED_ASSET_KINDS = new Set(['python-runtime', 'wheelhouse', 'qmd', 'model'])
const MODEL_ROLES = new Set(['embedding', 'reranker', 'generator'])
const FAILURE_CODES = new Set(['args', 'resources', 'native', 'fixture', 'model', 'qmd', 'proxy', 'runtime', 'child'])

function inside(root, path) {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function failure(code, message) {
  const error = new Error(message)
  error.packageVerifyCode = code
  return error
}

async function requireEntry(path, label) {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() && !metadata.isDirectory()) throw new Error('invalid entry')
    return metadata
  } catch {
    throw new Error(`Packaged ${label} is missing`)
  }
}

async function verifyResourceAsset(path, asset) {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size !== asset.size) throw new Error('asset metadata mismatch')
    const digest = createHash('sha256').update(await readFile(path)).digest('hex')
    if (digest !== asset.sha256) throw new Error('asset digest mismatch')
  } catch {
    throw new Error(`Packaged runtime asset ${asset.id} is invalid`)
  }
}

async function verifyWheelhouse(path) {
  let entries
  try {
    const metadata = await stat(path)
    if (!metadata.isDirectory()) throw new Error('wheelhouse is not a directory')
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    throw new Error('Packaged Python wheelhouse is missing')
  }

  const applicationWheels = entries.filter((entry) =>
    entry.isFile() && /^speech_to_speech[-_][^/]+\.whl$/i.test(entry.name),
  )
  if (applicationWheels.length === 0) {
    throw new Error('Packaged Python wheelhouse has no versioned speech_to_speech wheel')
  }

  for (const entry of applicationWheels) {
    const contents = await readFile(join(path, entry.name))
    if (contents.length < 4 || contents[0] !== 0x50 || contents[1] !== 0x4b || contents[2] !== 0x03 || contents[3] !== 0x04) {
      throw new Error('Packaged Python wheelhouse contains an invalid application wheel')
    }
  }
}

function validateManifest(manifest) {
  if (
    !manifest || manifest.schemaVersion !== 1 || manifest.platform !== SUPPORTED_PLATFORM ||
    typeof manifest.pythonAbi !== 'string' || !manifest.pythonAbi ||
    manifest.profile !== 'voice-default' || !Array.isArray(manifest.approvedProfiles) ||
    !manifest.approvedProfiles.includes('vec-only') ||
    manifest.approvedProfiles.some((profile) => !['vec-only', 'hybrid'].includes(profile)) ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error('Packaged runtime manifest is invalid')
  }

  const ids = new Set()
  const kinds = new Set()
  const modelRoles = new Set()
  for (const asset of manifest.assets) {
    const modelRole = asset?.kind === 'model' && typeof asset.role === 'string'
      ? asset.role
      : asset?.kind === 'model' && asset.id === 'embedding'
        ? 'embedding'
        : asset?.kind === 'model' && (asset.id === 'reranker' || asset.id === 'rerank')
          ? 'reranker'
          : asset?.kind === 'model' && (asset.id === 'generator' || asset.id === 'generation')
            ? 'generator'
            : undefined
    if (
      !asset || typeof asset !== 'object' || typeof asset.id !== 'string' || !asset.id || ids.has(asset.id) ||
      typeof asset.version !== 'string' || !asset.version || typeof asset.kind !== 'string' ||
      !REQUIRED_ASSET_KINDS.has(asset.kind) || (asset.kind !== 'model' && kinds.has(asset.kind)) ||
      (asset.kind === 'model' && asset.role !== undefined && !MODEL_ROLES.has(asset.role)) ||
      (modelRole !== undefined && modelRoles.has(modelRole)) ||
      !['resources', 'userData'].includes(asset.install) ||
      (asset.install === 'userData' && asset.kind !== 'model') ||
      (asset.install === 'resources' && (
        typeof asset.path !== 'string' || !asset.path || isAbsolute(asset.path) ||
        asset.path.includes('\\') || asset.path.split('/').some((part) => !part || part === '.' || part === '..')
      )) ||
      (asset.install === 'userData' && asset.path !== undefined) ||
      typeof asset.url !== 'string' || !asset.url.startsWith('https://') ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
      typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) {
      throw new Error('Packaged runtime manifest is invalid')
    }
    try {
      if (new URL(asset.url).protocol !== 'https:') throw new Error('not https')
    } catch {
      throw new Error('Packaged runtime manifest is invalid')
    }
    ids.add(asset.id)
    kinds.add(asset.kind)
    if (modelRole !== undefined) modelRoles.add(modelRole)
  }

  if ([...REQUIRED_ASSET_KINDS].some((kind) => !kinds.has(kind)) ||
    !manifest.assets.some((asset) => asset.kind === 'model' && (asset.role === 'embedding' || asset.id === 'embedding'))) {
    throw new Error('Packaged runtime manifest is incomplete')
  }
}

async function findNativeAddon(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const candidates = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) candidates.push(...await findNativeAddon(path))
    else if (entry.name.endsWith('.node')) candidates.push(path)
  }
  return candidates
}

export async function resolvePackageResources(resourcesRoot) {
  const root = resolve(resourcesRoot)
  const qmdRoot = join(root, 'qmd')
  const runtimeRoot = join(root, 'runtime')
  const manifestPath = join(root, 'runtime-manifest.json')
  const signaturePath = `${manifestPath}.sig`
  const qmdEntrypoint = join(qmdRoot, 'node_modules', '@tobilu', 'qmd', 'bin', 'qmd')
  const python = join(runtimeRoot, process.platform === 'win32' ? 'bin/python.exe' : 'bin/python')

  await requireEntry(manifestPath, 'runtime manifest')
  const signature = (await readFile(signaturePath, 'utf8').catch(() => '')).trim()
  if (!signature) throw new Error('Packaged runtime manifest signature is missing')
  await requireEntry(qmdEntrypoint, 'QMD entrypoint')
  await requireEntry(python, 'Python runtime')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  validateManifest(manifest)

  const realRoot = await realpath(root)
  for (const path of [qmdRoot, runtimeRoot, manifestPath, qmdEntrypoint, python]) {
    if (!inside(root, path) || !inside(realRoot, await realpath(path))) {
      throw new Error('Packaged resource escapes installation root')
    }
  }

  const wheelhouseAsset = manifest.assets.find((asset) => asset.kind === 'wheelhouse')
  const wheelhouseAssetPath = resolve(root, wheelhouseAsset.path)
  if (!inside(root, wheelhouseAssetPath) || !inside(realRoot, await realpath(wheelhouseAssetPath))) {
    throw new Error('Packaged wheelhouse escapes installation root')
  }
  await requireEntry(wheelhouseAssetPath, 'Python wheelhouse')
  await verifyResourceAsset(wheelhouseAssetPath, wheelhouseAsset)
  const wheelhouseCandidate = join(runtimeRoot, 'wheelhouse')
  await verifyWheelhouse(wheelhouseCandidate)
  if (!inside(realRoot, await realpath(wheelhouseCandidate))) {
    throw new Error('Packaged wheelhouse escapes installation root')
  }
  const wheelhouseRoot = wheelhouseCandidate

  for (const asset of manifest.assets) {
    if (asset.install !== 'resources') continue
    const assetPath = resolve(root, asset.path)
    if (!inside(root, assetPath) || !inside(realRoot, await realpath(assetPath))) {
      throw new Error('Packaged runtime asset escapes installation root')
    }
    await requireEntry(assetPath, `runtime asset ${asset.id}`)
    await verifyResourceAsset(assetPath, asset)
  }

  const nativeCandidates = await findNativeAddon(qmdRoot)
  const nativeAddon = nativeCandidates.find((path) => path.includes('@node-llama-cpp')) ?? nativeCandidates[0]
  if (!nativeAddon) throw new Error('Packaged QMD native .node addon is missing')
  if (!inside(realRoot, await realpath(nativeAddon))) throw new Error('Packaged native addon escapes installation root')
  return { root, qmdRoot, runtimeRoot, manifestPath, qmdEntrypoint, python, wheelhouse: wheelhouseRoot, nativeAddon, manifest }
}

export async function verifyNativeAddon(resources) {
  if (!resources.nativeAddon) throw new Error('Packaged QMD native .node addon is missing')
  try {
    createRequire(import.meta.url)(resources.nativeAddon)
  } catch {
    throw new Error('Packaged QMD native .node addon failed to load')
  }
  return resources.nativeAddon
}

export function packageSmokeEnvironment(dataRoot) {
  const root = resolve(dataRoot)
  const qmdRoot = join(root, 'qmd')
  const environment = { ...process.env }
  delete environment.NODE_PATH
  delete environment.npm_config_prefix
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

export function parseVerifierArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const key = {
      '--app': 'app',
      '--fixture': 'fixture',
      '--data-root': 'dataRoot',
      '--smoke-model': 'smokeModel',
      '--metrics': 'metrics',
    }[flag]
    if (!key || values[key] !== undefined || typeof argv[index + 1] !== 'string' || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw failure('args', 'Verifier arguments are invalid')
    }
    values[key] = argv[index + 1]
    index += 1
  }
  if (Object.keys(values).length < 4) {
    throw failure('args', 'Verifier arguments are incomplete: --app --fixture --data-root --smoke-model')
  }
  return values
}

function packagedExecutable(app) {
  return join(resolve(app), 'Contents', 'MacOS', 'speech-to-speech')
}

function defaultRun(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'ignore'] })
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
}

export async function launchPackageVerify({ app, fixture, dataRoot, smokeModel, metrics, run = defaultRun }) {
  const childEnvironment = { ...process.env, PATH: '' }
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  delete childEnvironment.NODE_PATH
  delete childEnvironment.RUNTIME_MANIFEST_PATH
  const result = await run(
    packagedExecutable(app),
    [
      '--package-verify', '--fixture', fixture, '--data-root', dataRoot, '--smoke-model', smokeModel,
      ...(metrics ? ['--metrics', metrics] : []),
    ],
    { cwd: dirname(resolve(app)), env: childEnvironment },
  )
  if (result?.code !== 0) throw failure('child', 'Packaged app verification failed')
  return 'PACKAGE_VERIFY_OK'
}

export function formatPackageVerifyFailure(reason) {
  const requested = typeof reason === 'string' ? reason : reason?.packageVerifyCode
  const code = FAILURE_CODES.has(requested) ? requested : 'runtime'
  return `PACKAGE_VERIFY_FAILED:${code}`
}

async function verifyFixtureInputs(fixtureRoot) {
  for (const name of ['allergy.md', 'project-notes.md', 'malicious-instructions.md']) {
    await requireEntry(join(fixtureRoot, name), `Chinese fixture ${name}`)
  }
}

async function main() {
  try {
    const options = parseVerifierArgs(process.argv.slice(2))
    const resources = await resolvePackageResources(join(options.app, 'Contents', 'Resources'))
    try {
      await verifyNativeAddon(resources)
    } catch (error) {
      throw failure('native', error instanceof Error ? error.message : 'native addon failed')
    }
    try {
      await verifyFixtureInputs(options.fixture)
    } catch (error) {
      throw failure('fixture', error instanceof Error ? error.message : 'fixture is invalid')
    }
    await launchPackageVerify(options)
    process.stdout.write('PACKAGE_VERIFY_OK\n')
  } catch (error) {
    process.stderr.write(`${formatPackageVerifyFailure(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main()
}
