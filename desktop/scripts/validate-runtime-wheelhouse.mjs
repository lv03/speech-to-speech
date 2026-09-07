import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { collectPythonLicenses } from './generate-license-report.mjs'

function normalizeName(value) {
  return value.trim().toLowerCase().replaceAll(/[-_.]+/g, '-')
}

function expectedPackages(report) {
  if (!report || !Array.isArray(report.install) || report.install.length === 0) {
    throw new Error('Runtime closure report has no install entries')
  }

  const packages = new Map()
  for (const item of report.install) {
    const name = item?.metadata?.name
    const version = item?.metadata?.version
    if (typeof name !== 'string' || !name.trim() || typeof version !== 'string' || !version.trim()) {
      throw new Error('Runtime closure report contains invalid package metadata')
    }
    const normalized = normalizeName(name)
    if (packages.has(normalized)) throw new Error(`Runtime closure report contains duplicate package: ${name}`)
    packages.set(normalized, { name, version })
  }
  return packages
}

export async function validateRuntimeWheelhouse({
  wheelhouse,
  report,
  applicationPackage = 'speech-to-speech',
}) {
  const expected = expectedPackages(report)
  const applicationName = normalizeName(applicationPackage)
  if (!applicationName) throw new Error('Application package name is required')

  const entries = await collectPythonLicenses(wheelhouse)
  const actual = new Map()
  for (const entry of entries) {
    const normalized = normalizeName(entry.name)
    if (actual.has(normalized)) throw new Error(`Runtime wheelhouse contains duplicate package: ${entry.name}`)
    actual.set(normalized, entry)
  }

  const missing = [...expected.entries()]
    .filter(([name]) => !actual.has(name))
    .map(([, packageInfo]) => packageInfo.name)
  if (!actual.has(applicationName)) missing.push(applicationPackage)

  const extra = [...actual.entries()]
    .filter(([name]) => name !== applicationName && !expected.has(name))
    .map(([, entry]) => entry.name)

  const versionMismatches = [...expected.entries()]
    .filter(([name, packageInfo]) => actual.has(name) && actual.get(name).version !== packageInfo.version)
    .map(([name, packageInfo]) => `${packageInfo.name} expected ${packageInfo.version}, found ${actual.get(name).version}`)

  if (missing.length > 0 || extra.length > 0 || versionMismatches.length > 0) {
    const details = []
    if (missing.length > 0) details.push(`missing packages: ${missing.sort().join(', ')}`)
    if (extra.length > 0) details.push(`extra packages: ${extra.sort().join(', ')}`)
    if (versionMismatches.length > 0) details.push(`version mismatches: ${versionMismatches.sort().join('; ')}`)
    throw new Error(`Runtime wheelhouse does not match the locked base closure (${details.join('; ')})`)
  }

  return { packageCount: entries.length, packages: entries.map(({ name, version }) => ({ name, version })) }
}

function parseArgs(argv) {
  const values = {}
  const keys = new Map([
    ['--wheelhouse', 'wheelhouse'],
    ['--report', 'report'],
    ['--application-package', 'applicationPackage'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys.get(argv[index])
    if (!key || values[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Usage: validate-runtime-wheelhouse.mjs --wheelhouse DIR --report FILE [--application-package NAME]')
    }
    values[key] = argv[index + 1]
    index += 1
  }
  if (!values.wheelhouse || !values.report) {
    throw new Error('Usage: validate-runtime-wheelhouse.mjs --wheelhouse DIR --report FILE [--application-package NAME]')
  }
  return values
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = JSON.parse(await readFile(resolve(options.report), 'utf8'))
  const result = await validateRuntimeWheelhouse({
    wheelhouse: options.wheelhouse,
    report,
    applicationPackage: options.applicationPackage,
  })
  console.log(`Validated locked runtime wheelhouse: ${result.packageCount} packages`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
