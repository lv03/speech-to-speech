import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const QMD_PACKAGE = '@tobilu/qmd'
const EMBED_ROUTE_PATCH = 'qmd-embed-route.patch'
const EMBED_ROUTE_MARKER = 'pathname === "/embed"'
const QMD_SERVER_ENTRY = 'node_modules/@tobilu/qmd/dist/mcp/server.js'
const DEFAULT_PATCHES_DIRECTORY = resolve(dirname(new URL(import.meta.url).pathname), '..', 'patches')
const QMD_VERSION = '2.8.3'
const NATIVE_PREBUILD_TARGETS = new Set([
  'darwin-arm64', 'darwin-x64',
  'win32-arm64', 'win32-x64',
  'linux-arm64', 'linux-x64',
  'linuxmusl-arm64', 'linuxmusl-x64',
])

function matchesPlatform(values, current) {
  if (!Array.isArray(values) || values.length === 0) return true
  if (values.includes(`!${current}`)) return false
  const positive = values.filter((value) => !value.startsWith('!'))
  return positive.length === 0 || positive.includes(current)
}

function isCompatible(record, platform, arch) {
  return matchesPlatform(record.os, platform) && matchesPlatform(record.cpu, arch)
}

async function packageExists(packageRoot) {
  try {
    await readFile(join(packageRoot, 'package.json'))
    return true
  } catch {
    return false
  }
}

async function resolvePackage(packageName, fromDirectory) {
  let cursor = resolve(fromDirectory)
  while (true) {
    const candidate = join(cursor, 'node_modules', packageName)
    if (await packageExists(candidate)) return candidate
    if (cursor.endsWith('/node_modules')) {
      const directCandidate = join(cursor, packageName)
      if (await packageExists(directCandidate)) return directCandidate
    }
    const parent = dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

function lockKey(sourceRoot, packageRoot) {
  const packageRelativePath = relative(sourceRoot, packageRoot)
  if (packageRelativePath.startsWith('..') || isAbsolute(packageRelativePath)) {
    throw new Error(`QMD dependency resolves outside source node_modules: ${packageRoot}`)
  }
  return `node_modules/${packageRelativePath.split(sep).join('/')}`
}

function isIncompatibleNativePrebuild(source, packageRoot, platform, arch) {
  const relativePath = relative(packageRoot, source)
  const segments = relativePath.split(sep)
  const prebuildsIndex = segments.indexOf('prebuilds')
  if (prebuildsIndex < 0) return false
  const target = `${platform}-${arch}`
  return segments.slice(prebuildsIndex + 1).some((segment) => {
    const token = segment.replace(/\.node$/, '')
    return NATIVE_PREBUILD_TARGETS.has(token) && token !== target
  })
}

async function loadLockfile(lockfilePath) {
  const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8'))
  if (!lockfile.packages || typeof lockfile.packages !== 'object') {
    throw new Error(`QMD resource lockfile has no packages map: ${lockfilePath}`)
  }
  return lockfile.packages
}


/**
 * Apply the memory embed-route patch to the copied QMD bundle.
 *
 * The memory backend reuses QMD's loaded embedding model through `POST /embed`;
 * without this patch the route does not exist and memory reports a degraded
 * state instead of silently loading a second model. Applying it here keeps the
 * vendored bundle and the patch in sync at build time.
 *
 * Returns 'already' when the route is present, 'applied' when this call added it.
 */
export async function applyQmdEmbedRoutePatch(destination, { patchesDirectory = DEFAULT_PATCHES_DIRECTORY } = {}) {
  const serverFile = join(resolve(destination), QMD_SERVER_ENTRY)
  const before = await readFile(serverFile, 'utf8')
  if (before.includes(EMBED_ROUTE_MARKER)) return 'already'

  const patchPath = join(patchesDirectory, EMBED_ROUTE_PATCH)
  const patch = await readFile(patchPath)
  const result = spawnSync('patch', ['-p1', '--forward', '--batch', '-d', resolve(destination)], { input: patch })
  if (result.status !== 0) {
    const detail = (result.stderr?.toString() || result.stdout?.toString() || '').trim().slice(0, 400)
    throw new Error(`Failed to apply ${EMBED_ROUTE_PATCH} to the QMD bundle: ${detail}`)
  }
  const after = await readFile(serverFile, 'utf8')
  if (!after.includes(EMBED_ROUTE_MARKER)) {
    throw new Error(`${EMBED_ROUTE_PATCH} did not add the /embed route (QMD layout changed?)`)
  }
  return 'applied'
}

/**
 * Copy the lockfile-selected production closure of QMD into Electron's
 * extraResources directory. Source-relative locations preserve nested
 * production versions and their native package resolution.
 */
export async function prepareQmdResources({
  sourceNodeModules,
  destination,
  lockfilePath = join(resolve(sourceNodeModules), '..', 'package-lock.json'),
  patchesDirectory = DEFAULT_PATCHES_DIRECTORY,
  platform = process.platform,
  arch = process.arch,
}) {
  const sourceRoot = resolve(sourceNodeModules)
  const destinationRoot = resolve(destination)
  const packages = await loadLockfile(lockfilePath)
  const selected = new Map()

  async function visit(packageName, fromDirectory, required) {
    const packageRoot = await resolvePackage(packageName, fromDirectory)
    if (!packageRoot) {
      if (required) throw new Error(`Cannot resolve QMD production dependency: ${packageName}`)
      return
    }

    const packageLockKey = lockKey(sourceRoot, packageRoot)
    const record = packages[packageLockKey]
    if (!record || record.dev || !isCompatible(record, platform, arch)) return
    if (selected.has(packageLockKey)) return
    selected.set(packageLockKey, { packageName, packageRoot })

    for (const dependencyName of Object.keys(record.dependencies ?? {})) {
      await visit(dependencyName, packageRoot, true)
    }
    for (const dependencyName of Object.keys(record.optionalDependencies ?? {})) {
      await visit(dependencyName, packageRoot, false)
    }
  }

  const qmdRoot = await resolvePackage(QMD_PACKAGE, sourceRoot)
  if (!qmdRoot) throw new Error(`Cannot resolve ${QMD_PACKAGE} from ${sourceRoot}`)
  const qmdRecord = packages[lockKey(sourceRoot, qmdRoot)]
  if (!qmdRecord || qmdRecord.version !== QMD_VERSION) {
    throw new Error(`Expected ${QMD_PACKAGE}@${QMD_VERSION} in package-lock.json`)
  }
  await visit(QMD_PACKAGE, sourceRoot, true)

  const destinationNodeModules = join(destinationRoot, 'node_modules')
  await rm(destinationNodeModules, { recursive: true, force: true })
  await mkdir(destinationNodeModules, { recursive: true })

  for (const [packageLockKey, { packageRoot }] of selected) {
    const packageRelativePath = packageLockKey.slice('node_modules/'.length)
    const target = join(destinationNodeModules, packageRelativePath)
    await mkdir(dirname(target), { recursive: true })
    await cp(packageRoot, target, {
      recursive: true,
      force: true,
      dereference: true,
      filter: (source) => {
        if (isIncompatibleNativePrebuild(source, packageRoot, platform, arch)) return false
        const nestedNodeModules = join(packageRoot, 'node_modules')
        return source !== nestedNodeModules && !source.startsWith(`${nestedNodeModules}${sep}`)
      },
    })
  }

  const patchState = await applyQmdEmbedRoutePatch(destinationRoot, { patchesDirectory })

  return {
    packages: [...new Set([...selected.values()].map(({ packageName }) => packageName))].sort(),
    embedRoutePatch: patchState,
  }
}

async function main() {
  const scriptRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
  const sourceNodeModules = process.env.QMD_SOURCE_NODE_MODULES ?? join(scriptRoot, 'node_modules')
  const destination = process.env.QMD_RESOURCES_DIR ?? join(scriptRoot, 'build', 'qmd-resources')
  const { packages, embedRoutePatch } = await prepareQmdResources({ sourceNodeModules, destination })
  console.log(
    `Prepared QMD resources: ${packages.length} production packages at ${destination} (embed route patch: ${embedRoutePatch})`,
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
