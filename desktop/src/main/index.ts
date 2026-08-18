import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EmbeddedGateway } from './gateway-process'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ORB_WIDTH = 220
const ORB_HEIGHT = 220

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let gateway: EmbeddedGateway | null = null
let quitting = false

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

async function startGateway(): Promise<void> {
  gateway = new EmbeddedGateway()
  const url = await gateway.start()
  console.log(`[desktop] gateway ready at ${url}`)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gateway:ready', url)
  }
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

  // 先注册 IPC，再建窗口（renderer 加载后即可安全调用）
  ipcMain.handle('gateway:url', () => gatewayUrl())
  ipcMain.handle('gateway:create-task', async (_e, prompt: string, kind?: string) => {
    const body: Record<string, unknown> = { prompt }
    if (kind) body.kind = kind
    return gatewayFetch('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  })
  ipcMain.handle('gateway:list-tasks', () => gatewayFetch('/tasks'))
  ipcMain.on('app:quit', () => app.quit())

  createTray()
  createWindow()

  void startGateway().catch((error) => {
    console.error('[desktop] gateway 启动失败：', error)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:error', String(error))
    }
  })

  app.on('activate', () => showOrb())
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', (event) => {
  if (!gateway) return
  event.preventDefault()
  const g = gateway
  gateway = null
  void g.stop().finally(() => app.quit())
})
