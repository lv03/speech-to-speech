export {}

declare global {
  interface Window {
    desktop: {
      getGatewayUrl(): Promise<string | null>
      onGatewayReady(cb: (url: string) => void): void
      createTask(prompt: string, kind?: string): Promise<Record<string, unknown>>
      listTasks(): Promise<unknown[]>
      quit(): void
    }
  }
}
