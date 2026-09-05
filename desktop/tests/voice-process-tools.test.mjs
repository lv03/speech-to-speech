import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.match(/\.[cm]?[jt]sx?$/)) {
      try {
        return nextResolve(`${specifier}.ts`, context)
      } catch {
        try {
          return nextResolve(`${specifier}.js`, context)
        } catch {
          // Let the default resolver report the actual missing module.
        }
      }
    }
    return nextResolve(specifier, context)
  },
})

const { EmbeddedVoice, buildVoiceEnvironment } = await import('../src/main/voice-process.ts')

test('EmbeddedVoice loads the gateway and knowledge tool modules in a fixed order', () => {
  const voice = new EmbeddedVoice({
    root: tmpdir(),
    python: process.execPath,
    printJson: false,
  })

  const args = voice.buildArgs()
  const moduleIndex = args.indexOf('--tool-module')

  assert.notEqual(moduleIndex, -1)
  assert.equal(
    args[moduleIndex + 1],
    'speech_to_speech.tools.agent_gateway,speech_to_speech.tools.qmd_knowledge',
  )
})

test('knowledge proxy credentials are injected only into the voice child environment', () => {
  const env = buildVoiceEnvironment({
    baseEnv: {
      QMD_PROXY_URL: 'http://ambient.invalid',
      QMD_PROXY_TOKEN: 'ambient-secret',
      GATEWAY_URL: 'http://ambient-gateway.invalid',
    },
    gatewayUrl: 'http://127.0.0.1:3101',
    qmdProxyUrl: 'http://127.0.0.1:41234',
    qmdProxyToken: 'secret-token',
    llmApiKey: 'llm-secret',
  })

  assert.equal(env.GATEWAY_URL, 'http://127.0.0.1:3101')
  assert.equal(env.QMD_PROXY_URL, 'http://127.0.0.1:41234')
  assert.equal(env.QMD_PROXY_TOKEN, 'secret-token')
  assert.equal(env.OPENAI_API_KEY, 'llm-secret')

  const noProxyEnv = buildVoiceEnvironment({
    baseEnv: { QMD_PROXY_URL: 'http://ambient.invalid', QMD_PROXY_TOKEN: 'ambient-secret' },
    gatewayUrl: 'http://127.0.0.1:3101',
  })
  assert.equal(noProxyEnv.QMD_PROXY_URL, undefined)
  assert.equal(noProxyEnv.QMD_PROXY_TOKEN, undefined)
})

test('knowledge proxy token is absent from voice command arguments', () => {
  const voice = new EmbeddedVoice({
    root: tmpdir(),
    python: process.execPath,
    qmdProxyUrl: 'http://127.0.0.1:41234',
    qmdProxyToken: 'secret-token',
    printJson: false,
  })

  assert.equal(voice.buildArgs().includes('secret-token'), false)
  assert.equal(voice.buildArgs().includes('http://127.0.0.1:41234'), false)
})
