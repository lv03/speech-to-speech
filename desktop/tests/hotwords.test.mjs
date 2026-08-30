import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: 'mock:electron', shortCircuit: true }
    }
    if (specifier.startsWith('.') && !specifier.match(/\.[cm]?[jt]sx?$/)) {
      try {
        return nextResolve(`${specifier}.ts`, context)
      } catch {
        try {
          return nextResolve(`${specifier}.js`, context)
        } catch {
          // Fall through to the default resolver so Node can raise the real error.
        }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:electron') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const app = { getPath() { return "/private/tmp" } }; export default { app };',
      }
    }
    return nextLoad(url, context)
  },
})

const { DEFAULT_SETTINGS, SettingsStore } = await import('../src/main/settings.ts')
const { EmbeddedVoice } = await import('../src/main/voice-process.ts')

function normalizeArgs(args) {
  return args.filter((value) => value !== undefined && value !== null)
}

function makeVoice(options = {}) {
  return new EmbeddedVoice({
    root: tmpdir(),
    python: process.execPath,
    startupTimeoutMs: 1,
    printJson: false,
    ...options,
  })
}

test('DesktopSettings defaults sttHotwords to an empty string', () => {
  assert.equal(DEFAULT_SETTINGS.sttHotwords, '')

  const store = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'desktop-hotwords-')), 'settings.json'))
  assert.equal(store.get().sttHotwords, '')
})

test('SettingsStore normalizes persisted STT hotwords into space-separated unique tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-hotwords-'))
  const settingsPath = join(dir, 'settings.json')
  writeFileSync(
    settingsPath,
    JSON.stringify({
      sttHotwords: '  开放时间，开放时间,\n脐腐病  ,  脐腐病\n果树   ',
    }),
    'utf-8',
  )

  const store = new SettingsStore(settingsPath)
  assert.equal(store.get().sttHotwords, '开放时间 脐腐病 果树')

  rmSync(dir, { recursive: true, force: true })
})

test('EmbeddedVoice passes normalized hotwords to paraformer', () => {
  const voice = makeVoice({
    sttBackend: 'paraformer',
    sttHotwords: '开放时间 脐腐病',
  })

  const args = normalizeArgs(voice.buildArgs())
  const flagIndex = args.indexOf('--paraformer_stt_gen_hotword')

  assert.notEqual(flagIndex, -1)
  assert.equal(args[flagIndex + 1], '开放时间 脐腐病')
})

test('EmbeddedVoice passes normalized hotwords to fun-asr-nano and skips other STT backends', () => {
  const funVoice = makeVoice({
    sttBackend: 'fun-asr-nano',
    sttHotwords: '开放时间 脐腐病',
  })
  const otherVoice = makeVoice({
    sttBackend: 'whisper',
    sttHotwords: '开放时间 脐腐病',
  })

  const funArgs = normalizeArgs(funVoice.buildArgs())
  const otherArgs = normalizeArgs(otherVoice.buildArgs())

  const funFlagIndex = funArgs.indexOf('--fun_asr_nano_stt_gen_hotword')
  assert.notEqual(funFlagIndex, -1)
  assert.equal(funArgs[funFlagIndex + 1], '开放时间 脐腐病')
  assert.equal(otherArgs.includes('--paraformer_stt_gen_hotword'), false)
  assert.equal(otherArgs.includes('--fun_asr_nano_stt_gen_hotword'), false)
})
