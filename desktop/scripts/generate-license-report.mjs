import { inflateRawSync } from 'node:zlib'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function packageLicense(packageJson) {
  const value = packageJson.license ?? packageJson.licenses
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'string') return entry.trim()
      if (entry && typeof entry === 'object' && typeof entry.type === 'string') return entry.type.trim()
      return ''
    }).filter(Boolean).join(' OR ')
  }
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type.trim()
  return ''
}

function isMissingLicense(value) {
  return !value || /^(?:unknown|unlicensed|see license in)$/i.test(value.trim())
}

async function collectPackageJsonFiles(root, current = root, result = []) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.bin') continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      await collectPackageJsonFiles(root, path, result)
    } else if (entry.isFile() && entry.name === 'package.json') {
      result.push(path)
    }
  }
  return result
}

export async function collectNodeLicenses(nodeModulesRoot) {
  const root = resolve(nodeModulesRoot)
  const files = await collectPackageJsonFiles(root)
  if (files.length === 0) throw new Error(`QMD npm dependency closure is empty: ${root}`)
  const entries = []
  for (const file of files) {
    const packageJson = JSON.parse(await readFile(file, 'utf8'))
    if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') continue
    const license = packageLicense(packageJson)
    entries.push({
      ecosystem: 'npm',
      name: packageJson.name,
      version: packageJson.version,
      license,
      source: relative(root, file).split('\\').join('/'),
    })
  }
  return entries.sort(compareEntries)
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset)
}

function readUInt16(buffer, offset) {
  return buffer.readUInt16LE(offset)
}

function zipEntries(buffer) {
  const minimumEnd = Math.max(0, buffer.length - 0xffff - 22)
  let end = -1
  for (let offset = buffer.length - 22; offset >= minimumEnd; offset -= 1) {
    if (readUInt32(buffer, offset) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error('Wheel is not a valid ZIP archive')

  const count = readUInt16(buffer, end + 10)
  const directorySize = readUInt32(buffer, end + 12)
  const directoryOffset = readUInt32(buffer, end + 16)
  if (directoryOffset + directorySize > buffer.length) throw new Error('Wheel ZIP directory is invalid')

  const entries = []
  let offset = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (readUInt32(buffer, offset) !== 0x02014b50) throw new Error('Wheel ZIP entry is invalid')
    const method = readUInt16(buffer, offset + 10)
    const compressedSize = readUInt32(buffer, offset + 20)
    const nameSize = readUInt16(buffer, offset + 28)
    const extraSize = readUInt16(buffer, offset + 30)
    const commentSize = readUInt16(buffer, offset + 32)
    const localOffset = readUInt32(buffer, offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString('utf8')
    const localNameSize = readUInt16(buffer, localOffset + 26)
    const localExtraSize = readUInt16(buffer, localOffset + 28)
    const dataStart = localOffset + 30 + localNameSize + localExtraSize
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    let contents
    if (method === 0) contents = compressed
    else if (method === 8) contents = inflateRawSync(compressed)
    else throw new Error(`Unsupported ZIP compression method: ${method}`)
    entries.push({ name, contents })
    offset += 46 + nameSize + extraSize + commentSize
  }
  return entries
}

function metadataFields(text) {
  const fields = new Map()
  let current
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && current) {
      const values = fields.get(current)
      values[values.length - 1] += `\n${line.slice(1)}`
      continue
    }
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    current = line.slice(0, separator).toLowerCase()
    const value = line.slice(separator + 1).trim()
    const values = fields.get(current) ?? []
    values.push(value)
    fields.set(current, values)
  }
  return fields
}

export function parsePythonMetadata(text, source = 'wheel') {
  const fields = metadataFields(text)
  const name = fields.get('name')?.[0]
  const version = fields.get('version')?.[0]
  const expression = fields.get('license-expression')?.[0]
  const declared = fields.get('license')?.[0]
  const classifiers = fields.get('classifier') ?? []
  const licenseClassifiers = classifiers
    .filter((value) => value.startsWith('License ::'))
    .map((value) => value.replace(/^License ::\s*/, '').trim())
  const license = expression || (declared && !/^unknown$/i.test(declared) ? declared : licenseClassifiers.join(' OR ')) || ''
  if (!name || !version) throw new Error(`Python wheel metadata is missing Name or Version: ${source}`)
  const result = { ecosystem: 'python', name, version, license, source }
  const licenseFiles = fields.get('license-file') ?? []
  if (licenseFiles.length > 0) result.licenseFiles = licenseFiles
  return result
}

export async function collectPythonLicenses(wheelhouseRoot) {
  const root = resolve(wheelhouseRoot)
  const entries = await readdir(root, { withFileTypes: true })
  const wheels = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.whl'))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (wheels.length === 0) throw new Error(`Python wheelhouse is empty: ${root}`)
  const result = []
  for (const wheel of wheels) {
    const archive = await readFile(join(root, wheel.name))
    const metadata = zipEntries(archive).find((entry) => /\.dist-info\/METADATA$/i.test(entry.name))
    if (!metadata) throw new Error(`Python wheel has no dist-info/METADATA: ${wheel.name}`)
    result.push(parsePythonMetadata(metadata.contents.toString('utf8'), wheel.name))
  }
  return result.sort(compareEntries)
}

function compareEntries(left, right) {
  return `${left.ecosystem}:${left.name}:${left.version}:${left.source}`.localeCompare(
    `${right.ecosystem}:${right.name}:${right.version}:${right.source}`,
  )
}

export function buildLicenseReport({ npm, python }) {
  const entries = [...npm, ...python].sort(compareEntries)
  const missing = entries
    .filter((entry) => isMissingLicense(entry.license))
    .map(({ ecosystem, name, version, source, licenseFiles }) => ({ ecosystem, name, version, source, ...(licenseFiles ? { licenseFiles } : {}) }))
  return { schemaVersion: 1, entries, missing }
}

function markdownCell(value) {
  return String(value || 'MISSING').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderMarkdown(report) {
  const lines = [
    '# Third-Party License Inventory',
    '',
    'This file is generated from the packaged QMD npm closure and Python wheelhouse. It is an inventory, not a substitute for shipping the corresponding license texts and notices.',
    '',
    '| Ecosystem | Package | Version | License | Source |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const entry of report.entries) {
    lines.push(`| ${markdownCell(entry.ecosystem)} | ${markdownCell(entry.name)} | ${markdownCell(entry.version)} | ${markdownCell(entry.license)} | ${markdownCell(entry.source)} |`)
  }
  if (report.missing.length > 0) {
    lines.push('', '## Unresolved licenses', '', 'The release gate must not pass until every row below has a reviewed license source or an explicitly documented exception.', '')
    for (const entry of report.missing) {
      const files = entry.licenseFiles?.length ? `; license files: ${entry.licenseFiles.join(', ')}` : ''
      lines.push(`- ${entry.ecosystem}:${entry.name}@${entry.version} (${entry.source}${files})`)
    }
  }
  return `${lines.join('\n')}\n`
}

export async function generateLicenseReport({ nodeModules, wheelhouse, jsonOutput, markdownOutput }) {
  const [npm, python] = await Promise.all([
    collectNodeLicenses(nodeModules),
    collectPythonLicenses(wheelhouse),
  ])
  const report = buildLicenseReport({ npm, python })
  await writeFile(jsonOutput, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(markdownOutput, renderMarkdown(report), 'utf8')
  if (report.missing.length > 0) {
    throw new Error(`License inventory has ${report.missing.length} unresolved package(s)`)
  }
  return report
}

function parseArgs(argv) {
  const values = {}
  const keys = new Map([
    ['--node-modules', 'nodeModules'],
    ['--wheelhouse', 'wheelhouse'],
    ['--json', 'jsonOutput'],
    ['--markdown', 'markdownOutput'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys.get(argv[index])
    if (!key || values[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Usage: generate-license-report.mjs [--node-modules DIR] [--wheelhouse DIR] [--json FILE] [--markdown FILE]')
    }
    values[key] = argv[index + 1]
    index += 1
  }
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return {
    nodeModules: values.nodeModules ?? process.env.LICENSE_NODE_MODULES ?? join(scriptRoot, 'build/qmd-resources/node_modules'),
    wheelhouse: values.wheelhouse ?? process.env.LICENSE_WHEELHOUSE ?? join(scriptRoot, 'build/runtime/wheelhouse'),
    jsonOutput: values.jsonOutput ?? process.env.LICENSE_REPORT_JSON ?? join(scriptRoot, 'build/licenses.json'),
    markdownOutput: values.markdownOutput ?? process.env.LICENSE_REPORT_MARKDOWN ?? join(scriptRoot, 'build/THIRD-PARTY-NOTICES.md'),
  }
}

async function main() {
  const report = await generateLicenseReport(parseArgs(process.argv.slice(2)))
  console.log(`Generated license inventory for ${report.entries.length} package(s)`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
