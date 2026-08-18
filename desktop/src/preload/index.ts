import { contextBridge, ipcRenderer } from 'electron'

export interface DesktopApi {
  /** 获取内嵌 Gateway 的 HTTP origin（如 http://127.0.0.1:3101） */
  getGatewayUrl(): Promise<string | null>
  /** Gateway 就绪事件（回传 URL） */
  onGatewayReady(cb: (url: string) => void): void
  /** 语音状态事件（listening/thinking/speaking/idle） */
  onVoiceState(cb: (state: string) => void): void
  /** 创建后台任务（POST /tasks） */
  createTask(prompt: string, kind?: string): Promise<Record<string, unknown>>
  /** 列出任务（GET /tasks） */
  listTasks(): Promise<unknown[]>
  /** 读取桌面设置 */
  getSettings(): Promise<Record<string, unknown>>
  /** 保存桌面设置 */
  saveSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>>
  /** 列出可用悬浮球皮肤（pet 包） */
  listSkins(): Promise<unknown[]>
  /** 报告用户活动（重置自动休眠倒计时） */
  reportActivity(): void
  /** 退出应用 */
  quit(): void
}

const api: DesktopApi = {
  getGatewayUrl: () => ipcRenderer.invoke('gateway:url'),
  onGatewayReady: (cb) => {
    ipcRenderer.on('gateway:ready', (_e, url: string) => cb(url))
  },
  onVoiceState: (cb) => {
    ipcRenderer.on('voice:state', (_e, state: string) => cb(state))
  },
  createTask: (prompt, kind) => ipcRenderer.invoke('gateway:create-task', prompt, kind),
  listTasks: () => ipcRenderer.invoke('gateway:list-tasks'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  listSkins: () => ipcRenderer.invoke('skin:list'),
  reportActivity: () => ipcRenderer.send('app:activity'),
  quit: () => ipcRenderer.send('app:quit'),
}

contextBridge.exposeInMainWorld('desktop', api)
