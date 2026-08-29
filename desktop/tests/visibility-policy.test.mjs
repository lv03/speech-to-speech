import assert from 'node:assert/strict'
import test from 'node:test'

import { isVoiceActivityState, shouldDelegateOrbSleepToVoice } from '../src/shared/visibility-policy.js'

test('voice wake-word mode delegates orb sleep to the voice engine when auto-hide is enabled', () => {
  assert.equal(
    shouldDelegateOrbSleepToVoice({
      enableVoice: true,
      wakeWordEnabled: true,
      autoHideSeconds: 60,
    }),
    true,
  )
  assert.equal(
    shouldDelegateOrbSleepToVoice({
      enableVoice: true,
      wakeWordEnabled: true,
      autoHideSeconds: 0,
    }),
    false,
  )
  assert.equal(
    shouldDelegateOrbSleepToVoice({
      enableVoice: true,
      wakeWordEnabled: false,
      autoHideSeconds: 60,
    }),
    false,
  )
})

test('voice activity states are the non-idle realtime states', () => {
  assert.equal(isVoiceActivityState('listening'), true)
  assert.equal(isVoiceActivityState('thinking'), true)
  assert.equal(isVoiceActivityState('speaking'), true)
  assert.equal(isVoiceActivityState('idle'), false)
  assert.equal(isVoiceActivityState('error'), false)
})
