import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { validateRuntimeWheelhouse } from '../scripts/validate-runtime-wheelhouse.mjs'

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

async function writeWheel(root, filename, name, version) {
  await writeFile(join(root, filename), storedZip(
    `${name.replaceAll('-', '_')}-${version}.dist-info/METADATA`,
    Buffer.from(`Name: ${name}\nVersion: ${version}\nLicense: MIT\n\n`),
  ))
}

function report(...packages) {
  return {
    install: packages.map(([name, version]) => ({ metadata: { name, version } })),
  }
}

test('accepts exactly the locked closure plus the application wheel', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-wheelhouse-'))
  await writeWheel(root, 'httpx-1.0-py3-none-any.whl', 'httpx', '1.0')
  await writeWheel(root, 'speech_to_speech-0.2.12-py3-none-any.whl', 'speech-to-speech', '0.2.12')

  await expect(validateRuntimeWheelhouse({
    wheelhouse: root,
    report: report(['httpx', '1.0']),
  })).resolves.toMatchObject({ packageCount: 2 })
})

test('rejects extra or duplicate packages outside the locked closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-wheelhouse-'))
  await writeWheel(root, 'httpx-1.0-py3-none-any.whl', 'httpx', '1.0')
  await writeWheel(root, 'funasr-1.0-py3-none-any.whl', 'funasr', '1.0')
  await writeWheel(root, 'speech_to_speech-0.2.12-py3-none-any.whl', 'speech-to-speech', '0.2.12')

  await expect(validateRuntimeWheelhouse({
    wheelhouse: root,
    report: report(['httpx', '1.0']),
  })).rejects.toThrow(/extra.*funasr/i)
})

test('rejects a selected wheel whose version differs from the closure report', async () => {
  const root = await mkdtemp(join(tmpdir(), 's2s-wheelhouse-'))
  await writeWheel(root, 'httpx-2.0-py3-none-any.whl', 'httpx', '2.0')
  await writeWheel(root, 'speech_to_speech-0.2.12-py3-none-any.whl', 'speech-to-speech', '0.2.12')

  await expect(validateRuntimeWheelhouse({
    wheelhouse: root,
    report: report(['httpx', '1.0']),
  })).rejects.toThrow(/version.*httpx/i)
})
