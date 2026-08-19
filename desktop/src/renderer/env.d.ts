export {}

declare global {
  interface Window {
    desktop: {
      getGatewayUrl(): Promise<string | null>
      onGatewayReady(cb: (url: string) => void): void
      onVoiceState(cb: (state: string) => void): void
      createTask(prompt: string, kind?: string): Promise<Record<string, unknown>>
      listTasks(): Promise<unknown[]>
      getSettings(): Promise<Record<string, unknown>>
      saveSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>>
      listSkins(): Promise<unknown[]>
      reportActivity(): void
      setPanelOpen(open: boolean): void
      setTaskCount(count: number): void
      toggleVoice(): Promise<Record<string, unknown>>
      voiceStatus(): Promise<Record<string, unknown>>
      onVoiceReady(cb: () => void): void
      onVoiceError(cb: (message: string) => void): void
      onVoiceStatusChange(cb: (status: string) => void): void
      onVoiceLog(cb: (line: string) => void): void
      openSettings(): void
      voiceprintStatus(): Promise<Record<string, unknown>>
      voiceprintEnroll(): Promise<Record<string, unknown>>
      voiceprintVerify(): Promise<Record<string, unknown>>
      onVoiceprintProgress(cb: (text: string) => void): void
      quit(): void
    }
  }
}
