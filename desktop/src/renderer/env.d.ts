export {}

declare global {
  interface Window {
    desktop: {
      getGatewayUrl(): Promise<string | null>
      onGatewayReady(cb: (url: string) => void): void
      createTask(prompt: string, kind?: string): Promise<Record<string, unknown>>
      listTasks(): Promise<unknown[]>
      getSettings(): Promise<Record<string, unknown>>
      saveSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>>
      listSkins(): Promise<unknown[]>
      reportActivity(): void
      quit(): void
    }
  }
}
