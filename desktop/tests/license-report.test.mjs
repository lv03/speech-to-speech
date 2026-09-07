import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import {
  buildLicenseReport,
  collectNodeLicenses,
  collectPythonLicenses,
  parsePythonMetadata,
  renderMarkdown,
} from '../scripts/generate-license-report.mjs'

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function storedZip(name, contents) {
  const filename = Buffer.from(name)
  const local = Buffer.alloc(30 + filename.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(crc32(contents), 14)
  local.writeUInt32LE(contents.length, 18)
  local.writeUInt32LE(contents.length, 22)
  local.writeUInt16LE(filename.length, 26)
  filename.copy(local, 30)

  const central = Buffer.alloc(46 + filename.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(crc32(contents), 16)
  central.writeUInt32LE(contents.length, 20)
  central.writeUInt32LE(contents.length, 24)
  central.writeUInt16LE(filename.length, 28)
  filename.copy(central, 46)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(local.length + contents.length, 16)
  return Buffer.concat([local, contents, central, end])
}

test('parses Python license expressions and classifier fallback', () => {
  expect(parsePythonMetadata([
    'Metadata-Version: 2.4',
    'Name: speech-to-speech',
    'Version: 0.2.12',
    'License-Expression: Apache-2.0',
    '',
  ].join('\n'), 'speech_to_speech-0.2.12.whl')).toEqual({
    ecosystem: 'python',
    name: 'speech-to-speech',
    version: '0.2.12',
    license: 'Apache-2.0',
    source: 'speech_to_speech-0.2.12.whl',
  })

  expect(parsePythonMetadata([
    'Name: qmd-client',
    'Version: 1.0',
    'License: UNKNOWN',
    'Classifier: License :: OSI Approved :: MIT License',
    '',
  ].join('\n'))).toMatchObject({ license: 'OSI Approved :: MIT License' })
})

test('renders a deterministic report and exposes unresolved licenses', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-licenses-'))
  const nodeModules = join(root, 'node_modules')
  await mkdir(join(nodeModules, 'example-package'), { recursive: true })
  await writeFile(join(nodeModules, 'example-package', 'package.json'), JSON.stringify({
    name: 'example-package', version: '1.0.0', license: 'MIT',
  }))
  const wheelhouse = join(root, 'wheelhouse')
  await mkdir(wheelhouse)
  await writeFile(join(wheelhouse, 'example-1.0-py3-none-any.whl'), storedZip(
    'example-1.0.dist-info/METADATA',
    Buffer.from('Name: example\nVersion: 1.0\nLicense: BSD-2-Clause\n\n'),
  ))
  const npm = await collectNodeLicenses(nodeModules)
  const python = await collectPythonLicenses(wheelhouse)
  expect(npm).toEqual([{
    ecosystem: 'npm', name: 'example-package', version: '1.0.0', license: 'MIT', source: 'example-package/package.json',
  }])
  expect(python).toEqual([{
    ecosystem: 'python', name: 'example', version: '1.0', license: 'BSD-2-Clause', source: 'example-1.0-py3-none-any.whl',
  }])
  const report = buildLicenseReport({
    npm,
    python: [
      ...python,
      { ecosystem: 'python', name: 'missing-license', version: '1.0.0', license: '', source: 'missing.whl' },
    ],
  })
  expect(report.missing).toEqual([{
    ecosystem: 'python', name: 'missing-license', version: '1.0.0', source: 'missing.whl',
  }])
  const markdown = renderMarkdown(report)
  expect(markdown).toContain('| npm | example-package | 1.0.0 | MIT |')
  expect(markdown).toContain('## Unresolved licenses')
  expect(markdown).toContain('python:missing-license@1.0.0')
})
