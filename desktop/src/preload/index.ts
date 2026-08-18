import { contextBridge, ipcRenderer } from 'electron'

export interface DesktopApi {
  /** 获取内嵌 Gateway 的 HTTP origin（如 http://127.0.0.1:3101） */
  getGatewayUrl(): Promise<string | null>
  /** Gateway 就绪事件（回传 URL） */
  onGatewayReady(cb: (url: string) => void): void
  /** 创建后台任务（POST /tasks） */
  createTask(prompt: string, kind?: string): Promise<Record<string, unknown>>
  /** 列出任务（GET /tasks） */
  listTasks(): Promise<unknown[]>
  /** 读取桌面设置 */
  getSettings(): Promise<Record<string, unknown>>
  /** 保存桌面设置 */
  saveSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>>
  /** 退出应用 */
  quit(): void
}

const api: DesktopApi = {
  getGatewayUrl: () => ipcRenderer.invoke('gateway:url'),
  onGatewayReady: (cb) => {
    ipcRenderer.on('gateway:ready', (_e, url: string) => cb(url))
  },
  createTask: (prompt, kind) => ipcRenderer.invoke('gateway:create-task', prompt, kind),
  listTasks: () => ipcRenderer.invoke('gateway:list-tasks'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  quit: () => ipcRenderer.send('app:quit'),
}

contextBridge.exposeInMainWorld('desktop', api)
