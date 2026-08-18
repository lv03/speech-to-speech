import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { EmbeddedGateway } from './gateway-process'
import { EmbeddedVoice } from './voice-process'
import { SettingsStore, type DesktopSettings } from './settings'
import { listSkins, skinDirectories, type SkinInfo } from './skin-catalog'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ORB_WIDTH = 220
const ORB_HEIGHT = 220

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null
let gateway: EmbeddedGateway | null = null
let voice: EmbeddedVoice | null = null
let settingsStore: SettingsStore | null = null
let skinsCache: SkinInfo[] = []
let hideTimer: NodeJS.Timeout | null = null

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
    { label: '退出', click: () => app.quit() },
  ]))
}

function showOrb(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    return
  }
  createWindow()
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
  voice = new EmbeddedVoice({
    wakeWordEnabled: settings.wakeWordEnabled,
    wakeWord: settings.wakeWord,
    gatewayUrl: gatewayUrl() ?? 'http://127.0.0.1:3101',
    voiceprintEnabled: settings.enableVoiceprint,
    onEvent: (event) => {
      const state = voiceStateFromEvent(event)
      if (state && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice:state', state)
      }
    },
  })
  await voice.start()
  console.log('[desktop] voice engine ready')
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
  ipcMain.on('app:quit', () => app.quit())
  ipcMain.on('app:activity', () => recordActivity())

  createTray()
  createWindow()

  // 全局快捷键 + 初始自动休眠倒计时
  registerWakeShortcut(settingsStore?.get().wakeShortcut ?? '')
  recordActivity()

  void startGateway()
    .then(() => startVoice())
    .catch((error) => {
      console.error('[desktop] 服务启动失败：', error)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gateway:error', String(error))
      }
    })

  app.on('activate', () => showOrb())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', (event) => {
  globalShortcut.unregisterAll()
  clearHideTimer()
  if (!gateway && !voice) return
  event.preventDefault()
  const stops: Promise<void>[] = []
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
