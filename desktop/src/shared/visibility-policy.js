/**
 * Decide whether the voice engine should own orb sleep/lock behavior.
 * @param {{ enableVoice?: boolean; wakeWordEnabled?: boolean; autoHideSeconds?: number }} settings
 */
export function shouldDelegateOrbSleepToVoice(settings) {
  return Boolean(settings.enableVoice && settings.wakeWordEnabled && (settings.autoHideSeconds ?? 0) > 0)
}

/** @param {string} state */
export function isVoiceActivityState(state) {
  return state === 'listening' || state === 'thinking' || state === 'speaking'
}
