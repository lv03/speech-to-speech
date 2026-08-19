import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, protocol, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { EmbeddedAnnouncer } from './announcer-process'
import { EmbeddedGateway } from './gateway-process'
import { EmbeddedVoice } from './voice-process'
import { SettingsStore, type DesktopSettings } from './settings'
import { listSkins, skinDirectories, type SkinInfo } from './skin-catalog'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ORB_WIDTH = 220
const ORB_HEIGHT = 220
// 面板展开时窗口的尺寸（需容纳悬浮球 + 任务面板）
const PANEL_WIDTH = 340
const PANEL_HEIGHT = 560

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null
let gateway: EmbeddedGateway | null = null
let voice: EmbeddedVoice | null = null
let settingsStore: SettingsStore | null = null
let skinsCache: SkinInfo[] = []
let hideTimer: NodeJS.Timeout | null = null
let announcer: EmbeddedAnnouncer | null = null
let gatewayWs: WebSocket | null = null
const announcedTaskIds = new Set<string>()
let pendingSpeak: string[] = []

// ── 快捷键与自动休眠 ───────────────────────────────────────────────────

function registerWakeShortcut(accelerator: string): boolean {
  if (!accelerator) return false
  try {
    return globalShortcut.register(accelerator, () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        showOrb()
      }
    })
  } catch {
    return false
  }
}

function clearHideTimer(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

/** 用户活动时重置自动休眠倒计时；到点则隐藏悬浮球。 */
function recordActivity(): void {
  clearHideTimer()
  const seconds = settingsStore?.get().autoHideSeconds ?? 0
  if (!seconds) return
  hideTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide()
    }
  }, seconds * 1000)
}

function refreshSkins(): SkinInfo[] {
  const ownSkins = join(app.getPath('userData'), 'skins')
  skinsCache = listSkins(skinDirectories(ownSkins))
  return skinsCache
}

function findSkin(id: string): SkinInfo | undefined {
  return skinsCache.find((s) => s.id === id)
}

/** 注册 skin:// 协议，让 renderer 能加载磁盘上的 pet 包贴图。 */
function registerSkinProtocol(): void {
  protocol.handle('skin', (request) => {
    const url = new URL(request.url)
    const skinId = url.hostname
    const skin = findSkin(skinId)
    if (!skin) return new Response('skin not found', { status: 404 })
    const file = decodeURIComponent(url.pathname.slice(1))
    const target = resolve(skin.directory, file)
    // 安全：只允许读皮肤目录内的文件
    if (!target.startsWith(skin.directory)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

// 一个简单的圆形 SVG 图标，用作托盘图标
function trayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18">
    <circle cx="9" cy="9" r="8" fill="#6366f1"/><circle cx="9" cy="9" r="4" fill="#fff"/>
  </svg>`
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  if (process.platform === 'darwin') img.setTemplateImage(true)
  return img
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: ORB_WIDTH,
    height: ORB_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  mainWindow.setAlwaysOnTop(true, 'floating')
  mainWindow.setMenuBarVisibility(false)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('speech-to-speech')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示悬浮球', click: () => showOrb() },
    { label: '设置…', click: () => showSettings() },
    { type: 'separator' },
    { label: '退出', click: () => { console.log('[desktop] quit via tray'); app.quit() } },
  ]))
}

function showOrb(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    return
  }
  createWindow()
}

/** 面板展开/收起时动态调整窗口尺寸，保持窗口中心不变。 */
function setPanelOpen(open: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const bounds = mainWindow.getBounds()
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  const width = open ? PANEL_WIDTH : ORB_WIDTH
  const height = open ? PANEL_HEIGHT : ORB_HEIGHT
  mainWindow.setBounds({
    x: Math.round(cx - width / 2),
    y: Math.round(cy - height / 2),
    width,
    height,
  })
}

function createSettingsWindow(): void {
  settingsWindow = new BrowserWindow({
    width: 500,
    height: 620,
    minWidth: 460,
    minHeight: 560,
    title: 'speech-to-speech 设置',
    backgroundColor: '#f4f5f6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  settingsWindow.setMenuBarVisibility(false)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`)
  } else {
    void settingsWindow.loadFile(join(__dirname, '../renderer/settings.html'))
  }

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

function showSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  createSettingsWindow()
}

async function startGateway(): Promise<void> {
  const settings = settingsStore?.get() ?? { gatewayPort: 3101 }
  gateway = new EmbeddedGateway({ port: settings.gatewayPort })
  const url = await gateway.start()
  console.log(`[desktop] gateway ready at ${url}`)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gateway:ready', url)
  }
}

async function startVoice(): Promise<void> {
  const settings = settingsStore?.get()
  if (!settings?.enableVoice) return
  pushVoiceStatus('starting')
  const v = new EmbeddedVoice({
    wakeWordEnabled: settings.wakeWordEnabled,
    wakeWord: settings.wakeWord,
    gatewayUrl: gatewayUrl() ?? 'http://127.0.0.1:3101',
    voiceprintEnabled: settings.enableVoiceprint,
    llmBackend: settings.llmBackend,
    llmApiKey: settings.llmApiKey,
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    sttBackend: settings.sttBackend,
    sttModel: settings.sttModel,
    ttsBackend: settings.ttsBackend,
    ttsVoice: settings.ttsVoice,
    onLog: (line) => pushVoiceLog(line),
    onEvent: (event) => {
      const state = voiceStateFromEvent(event)
      if (state && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice:state', state)
      }
    },
  })
  voice = v
  try {
    await v.start()
    pushVoiceStatus('running')
    console.log('[desktop] voice engine ready')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice:ready', true)
    }
  } catch (error) {
    voice = null
    pushVoiceStatus('error')
    console.error('[desktop] 语音引擎启动失败：', error)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice:error', String(error))
    }
    throw error
  }
}

/** 推送语音引擎状态给 orb 与设置窗口。 */
function pushVoiceStatus(status: string): void {
  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('voice:status-change', status)
    }
  }
}

/** 推送语音引擎日志给设置窗口。 */
function pushVoiceLog(line: string): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('voice:log', line)
  }
}

// ── 任务完成通知 + 语音播报 ─────────────────────────────────────────────

/** 弹系统通知。 */
function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body }).show()
}

/** 摘要截断（用于播报/通知，避免念出整段结果）。 */
function summarize(text: string | undefined, max = 60): string {
  const s = (text || '').trim()
  return s.length > max ? `${s.slice(0, max)}……` : s
}

/** 任务完成/失败/取消时：系统通知 + Qwen3 语音播报。 */
function announceTaskCompletion(task: Record<string, unknown>): void {
  const id = String(task.id || '')
  if (!id || announcedTaskIds.has(id)) return
  announcedTaskIds.add(id)
  const status = String(task.status || '')
  let body = ''
  if (status === 'completed') body = `任务已完成：${summarize(task.result as string | undefined)}`
  else if (status === 'failed') body = `任务执行失败：${summarize(task.error as string | undefined)}`
  else if (status === 'cancelled') body = '任务已取消'
  else return
  notify('speech-to-speech', body)
  if (announcer?.running) {
    announcer.speak(body)
  } else {
    pendingSpeak.push(body)
    ensureAnnouncer()
  }
}

/** 订阅 Gateway /events，驱动任务完成通知。 */
function subscribeGatewayEvents(): void {
  const base = gatewayUrl()
  if (!base) return
  gatewayWs?.close()
  const wsUrl = `${base.replace(/^http/, 'ws')}/events`
  const ws = new WebSocket(wsUrl)
  gatewayWs = ws
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string)
      if (msg.event !== 'status') return
      const task = (msg.data?.task ?? null) as Record<string, unknown> | null
      const status = String(msg.data?.status ?? task?.status ?? '')
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        if (task) announceTaskCompletion(task)
      }
    } catch {
      // 忽略无法解析的消息
    }
  }
  ws.onclose = () => {
    if (gatewayWs === ws) gatewayWs = null
    setTimeout(() => {
      if (gatewayUrl()) subscribeGatewayEvents()
    }, 3000)
  }
}

/** 懒加载 Qwen3 语音播报守护进程（首次任务完成时才加载，避免与语音引擎并发抢内存）。 */
function ensureAnnouncer(): void {
  if (announcer) return
  const settings = settingsStore?.get()
  const a = new EmbeddedAnnouncer({
    speaker: settings?.ttsVoice || '',
    onLog: (line) => pushVoiceLog(line),
  })
  announcer = a
  void a.start()
    .then(() => {
      console.log('[desktop] announcer ready')
      for (const text of pendingSpeak) a.speak(text)
      pendingSpeak = []
    })
    .catch((error) => {
      console.error('[desktop] 语音播报服务启动失败：', error)
      announcer = null
    })
}

async function toggleVoice(): Promise<{ running: boolean; starting: boolean }> {
  if (voice) {
    if (voice.running) {
      await voice.stop()
      voice = null
      return { running: false, starting: false }
    }
    // 模型加载中，避免重复启动第二个引擎
    return { running: false, starting: true }
  }
  // 后台启动语音引擎（模型加载较慢），不阻塞按钮反馈。
  // 就绪/失败通知（voice:ready / voice:error）已在 startVoice 内发送。
  void startVoice().catch(() => {})
  return { running: false, starting: true }
}

/** 任务面板显示/隐藏时调整窗口尺寸（保持中心稳定）。 */
function setTaskCount(count: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const bounds = mainWindow.getBounds()
  const open = count > 0
  const width = open ? PANEL_WIDTH : ORB_WIDTH
  const height = open ? PANEL_HEIGHT : ORB_HEIGHT
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  mainWindow.setBounds({
    x: Math.round(cx - width / 2),
    y: Math.round(cy - height / 2),
    width,
    height,
  })
}

/** Realtime 事件 → orb 语音状态（用于驱动宠物动画）。 */
function voiceStateFromEvent(event: Record<string, unknown>): string | null {
  const type = String(event.type || '')
  switch (type) {
    case 'input_audio_buffer.speech_started':
      return 'listening'
    case 'response.created':
      return 'thinking'
    case 'response.output_audio.delta':
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      return 'speaking'
    case 'response.done':
      return 'idle'
    default:
      return null
  }
}

// ── 声纹 ──────────────────────────────────────────────────────────────

function voiceprintPath(): string {
  return join(homedir(), '.cache', 'speech_to_speech', 'voiceprint', 'default.npz')
}

function pythonForCommands(): string {
  return process.env.GATEWAY_PYTHON || join(__dirname, '../../../.venv/bin/python')
}

/** spawn 一个 voiceprint 子命令，stdout/stderr 实时推送给设置窗口。 */
async function runVoiceprintCommand(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(pythonForCommands(), args, { cwd: resolve(__dirname, '../../..') })
    let output = ''
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('voiceprint:progress', text)
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('close', (code) => {
      resolvePromise({ ok: code === 0, output })
    })
  })
}

// ── IPC ────────────────────────────────────────────────────────────────

function gatewayUrl(): string | null {
  return gateway?.url ?? null
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<unknown> {
  const base = gatewayUrl()
  if (!base) throw new Error('Gateway 未启动')
  const resp = await fetch(`${base}${path}`, init)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Gateway 请求失败：${resp.status} ${text}`)
  }
  return resp.json()
}

// ── 生命周期 ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }

  settingsStore = new SettingsStore()
  refreshSkins()
  registerSkinProtocol()

  // 先注册 IPC，再建窗口（renderer 加载后即可安全调用）
  ipcMain.handle('gateway:url', () => gatewayUrl())
  ipcMain.handle('skin:list', () => refreshSkins().map((s) => ({
    id: s.id,
    displayName: s.displayName,
    spriteVersionNumber: s.spriteVersionNumber,
    frame: s.frame,
    spritesheetUrl: `skin://${s.id}/${s.spritesheetPath}`,
  })))
  ipcMain.handle('gateway:create-task', async (_e, prompt: string, kind?: string) => {
    const body: Record<string, unknown> = { prompt }
    body.kind = kind || settingsStore?.get().agentKind || 'pi'
    return gatewayFetch('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  })
  ipcMain.handle('gateway:list-tasks', () => gatewayFetch('/tasks'))
  ipcMain.handle('voiceprint:status', () => ({
    enrolled: existsSync(voiceprintPath()),
    path: voiceprintPath(),
  }))
  ipcMain.handle('voiceprint:enroll', () => {
    const wakeWord = settingsStore?.get().wakeWord || '噜噜噜噜'
    return runVoiceprintCommand([
      '-m', 'speech_to_speech.cli', 'voiceprint', 'enroll',
      '--takes', '3', '--wake-word', wakeWord,
    ])
  })
  ipcMain.handle('voiceprint:verify', () => {
    return runVoiceprintCommand(['-m', 'speech_to_speech.cli', 'voiceprint', 'verify'])
  })
  ipcMain.handle('settings:get', () => settingsStore?.get() ?? {})
  ipcMain.handle('settings:save', (_e, settings: Partial<DesktopSettings>) => {
    const before = settingsStore?.get()
    const saved = settingsStore?.save(settings)
    // 皮肤变化 → 重载 orb 让新皮肤生效
    if (before && saved && settings.orbSkin !== undefined && before.orbSkin !== saved.orbSkin) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.reload()
      }
    }
    // 快捷键变化 → 重新注册
    if (before && saved && settings.wakeShortcut !== undefined && before.wakeShortcut !== saved.wakeShortcut) {
      globalShortcut.unregister(before.wakeShortcut)
      registerWakeShortcut(saved.wakeShortcut)
    }
    recordActivity()
    return saved ?? {}
  })
  ipcMain.on('app:quit', () => {
    console.log('[desktop] app:quit via IPC')
    app.quit()
  })
  ipcMain.on('app:activity', () => recordActivity())
  ipcMain.on('orb:panel-open', (_e, open: boolean) => setPanelOpen(Boolean(open)))
  ipcMain.on('orb:task-count', (_e, count: number) => setTaskCount(Number(count) || 0))
  ipcMain.handle('voice:toggle', () => toggleVoice())
  ipcMain.handle('voice:status', () => ({ running: voice?.running ?? false }))
  ipcMain.on('app:open-settings', () => showSettings())

  createTray()
  createWindow()

  // 全局快捷键 + 初始自动休眠倒计时
  registerWakeShortcut(settingsStore?.get().wakeShortcut ?? '')
  recordActivity()

  void startGateway()
    .then(() => {
      subscribeGatewayEvents()
      return startVoice()
    })
    .catch((error) => {
      console.error('[desktop] 服务启动失败：', error)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gateway:error', String(error))
      }
    })

  app.on('activate', () => showOrb())
})

app.on('window-all-closed', () => {
  console.log('[desktop] window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  console.log('[desktop] before-quit fired (gateway=%s voice=%s announcer=%s)', !!gateway, !!voice, !!announcer)
})

app.on('will-quit', (event) => {
  console.log('[desktop] will-quit fired (gateway=%s voice=%s announcer=%s)', !!gateway, !!voice, !!announcer)
  globalShortcut.unregisterAll()
  clearHideTimer()
  gatewayWs?.close()
  gatewayWs = null
  if (!gateway && !voice && !announcer) return
  event.preventDefault()
  const stops: Promise<void>[] = []
  if (announcer) {
    const a = announcer
    announcer = null
    stops.push(a.stop())
  }
  if (voice) {
    const v = voice
    voice = null
    stops.push(v.stop())
  }
  if (gateway) {
    const g = gateway
    gateway = null
    stops.push(g.stop())
  }
  void Promise.allSettled(stops).finally(() => app.quit())
})
