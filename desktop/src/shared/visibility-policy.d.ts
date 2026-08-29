export interface VisibilitySettings {
  enableVoice?: boolean
  wakeWordEnabled?: boolean
  autoHideSeconds?: number
}

export function shouldDelegateOrbSleepToVoice(settings: VisibilitySettings): boolean
export function isVoiceActivityState(state: string): boolean
