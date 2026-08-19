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
  /** 面板展开/收起（调整窗口尺寸） */
  setPanelOpen(open: boolean): void
  /** 任务卡片数量（调整窗口高度） */
  setTaskCount(count: number): void
  /** 切换语音引擎启停 */
  toggleVoice(): Promise<Record<string, unknown>>
  /** 查询语音引擎状态 */
  voiceStatus(): Promise<Record<string, unknown>>
  /** 语音引擎就绪事件 */
  onVoiceReady(cb: () => void): void
  /** 语音引擎错误事件 */
  onVoiceError(cb: (message: string) => void): void
  /** 语音引擎状态变化（starting/running/stopped） */
  onVoiceStatusChange(cb: (status: string) => void): void
  /** 语音引擎日志 */
  onVoiceLog(cb: (line: string) => void): void
  /** 打开设置窗口 */
  openSettings(): void
  /** 查询声纹注册状态 */
  voiceprintStatus(): Promise<Record<string, unknown>>
  /** 注册声纹（录 3 遍唤醒词） */
  voiceprintEnroll(): Promise<Record<string, unknown>>
  /** 验证声纹 */
  voiceprintVerify(): Promise<Record<string, unknown>>
  /** 声纹命令进度事件 */
  onVoiceprintProgress(cb: (text: string) => void): void
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
  setPanelOpen: (open) => ipcRenderer.send('orb:panel-open', open),
  setTaskCount: (count) => ipcRenderer.send('orb:task-count', count),
  toggleVoice: () => ipcRenderer.invoke('voice:toggle'),
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  onVoiceReady: (cb) => {
    ipcRenderer.on('voice:ready', () => cb())
  },
  onVoiceError: (cb) => {
    ipcRenderer.on('voice:error', (_e, message: string) => cb(message))
  },
  onVoiceStatusChange: (cb) => {
    ipcRenderer.on('voice:status-change', (_e, status: string) => cb(status))
  },
  onVoiceLog: (cb) => {
    ipcRenderer.on('voice:log', (_e, line: string) => cb(line))
  },
  openSettings: () => ipcRenderer.send('app:open-settings'),
  voiceprintStatus: () => ipcRenderer.invoke('voiceprint:status'),
  voiceprintEnroll: () => ipcRenderer.invoke('voiceprint:enroll'),
  voiceprintVerify: () => ipcRenderer.invoke('voiceprint:verify'),
  onVoiceprintProgress: (cb) => {
    ipcRenderer.on('voiceprint:progress', (_e, text: string) => cb(text))
  },
  quit: () => ipcRenderer.send('app:quit'),
}

contextBridge.exposeInMainWorld('desktop', api)
