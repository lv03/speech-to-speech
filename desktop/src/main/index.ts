import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, protocol, Tray } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { EmbeddedGateway } from './gateway-process'
import { EmbeddedVoice } from './voice-process'
import { SettingsStore, type DesktopSettings } from './settings'
import { SecretStore } from './secret-store'
import { publicModelStatus, sanitizePublicReason } from './runtime-types'
import type { CollectionRecord, KnowledgeModelStatus, KnowledgeSnapshot, RuntimeManifest } from './runtime-types'
import { QmdService } from './qmd-service'
import { QmdIndexer } from './qmd-indexer'
import { QmdProxy, type QmdProxyEndpoint } from './qmd-proxy'
import { QmdMcpClient } from './qmd-mcp-client'
import { ModelStore } from './model-store'
import { QmdRuntime } from './qmd-runtime'
import { RuntimeManager, startProcessesInOrder, stopProcessesInOrder } from './runtime-manager'
import { PythonRuntime } from './python-runtime'
import { getIndexFingerprint, getRetrievalProfiles } from './retrieval-profile'
import type { RuntimePaths } from './runtime-types'
import { parseAndVerifyRuntimeManifest } from './runtime-manifest'
import { EMBEDDED_RUNTIME_MANIFEST_PUBLIC_KEY_PEM } from './runtime-manifest-public-key'
import { listSkins, skinDirectories, type SkinInfo } from './skin-catalog'
import { isVoiceActivityState, shouldDelegateOrbSleepToVoice } from '../shared/visibility-policy.js'

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
let secretStore: SecretStore | null = null
let knowledgeService: QmdService | null = null
let knowledgeProxy: QmdProxy | null = null
let knowledgeProxyEndpoint: QmdProxyEndpoint | null = null
let runtimeManager: RuntimeManager | null = null
let pythonRuntime: PythonRuntime | null = null
let pythonRuntimePaths: RuntimePaths | null = null
let runtimeManifestError: string | null = null
let skinsCache: SkinInfo[] = []
let hideTimer: NodeJS.Timeout | null = null
let gatewayWs: WebSocket | null = null
const announcedTaskIds = new Set<string>()
let pendingSpeak: string[] = []
let voiceOwnsVisibility = false

function pushKnowledgeSnapshot(snapshot: { state: string; reason?: string; model: KnowledgeModelStatus; collections: PublicKnowledgeCollection[] }): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('knowledge:snapshot-changed', snapshot)
  }
}

/** 影响运行中语音引擎行为的设置字段（变化时需重启引擎才生效）。 */
const VOICE_AFFECTING_FIELDS = [
  'llmBackend', 'llmBaseUrl', 'llmModel',
  'sttBackend', 'sttModel', 'ttsBackend', 'ttsVoice',
  'sttHotwords', 'wakeWordEnabled', 'wakeWord', 'autoHideSeconds', 'enableVoiceprint', 'voiceprintThreshold', 'llmReasoningEffort',
] as const

const COLLECTION_ID = /^col_[a-f0-9]{32}$/

const EMPTY_RUNTIME_MANIFEST: RuntimeManifest = {
  schemaVersion: 1,
  platform: 'darwin-arm64',
  pythonAbi: 'unavailable',
  profile: 'voice-default',
  approvedProfiles: ['vec-only'],
  assets: [],
}

function loadRuntimeManifest(): { manifest: RuntimeManifest; error?: string } {
  let manifestPath: string | null = app.isPackaged
    ? join(process.resourcesPath, 'runtime-manifest.json')
    : process.env.RUNTIME_MANIFEST_PATH ?? null
  if (!manifestPath && !app.isPackaged) {
    // 开发默认：若存在 hybrid 批准版（reranker/generator 资产齐备）则使用它，
    // 否则保持 vec-only（EMPTY）语义。由 scripts/make-hybrid-manifest.mjs 生成。
    const devHybridManifest = join(__dirname, '../../build/runtime-manifest.hybrid.json')
    if (existsSync(devHybridManifest)) manifestPath = devHybridManifest
  }
  if (!manifestPath) {
    return { manifest: EMPTY_RUNTIME_MANIFEST, error: 'Knowledge runtime manifest is unavailable' }
  }
  try {
    const text = readFileSync(manifestPath, 'utf8')
    if (app.isPackaged) {
      if (!EMBEDDED_RUNTIME_MANIFEST_PUBLIC_KEY_PEM) throw new Error('Manifest public key is unavailable')
      const signaturePath = `${manifestPath}.sig`
      const signature = readFileSync(signaturePath, 'utf8')
      return {
        manifest: parseAndVerifyRuntimeManifest(
          text,
          signature,
          EMBEDDED_RUNTIME_MANIFEST_PUBLIC_KEY_PEM,
          { requireSignature: true },
        ),
      }
    }
    return { manifest: parseAndVerifyRuntimeManifest(text, undefined, undefined) }
  } catch (error) {
    return {
      manifest: EMPTY_RUNTIME_MANIFEST,
      error: 'Knowledge runtime manifest is invalid or unavailable',
    }
  }
}

async function ensurePythonRuntime(): Promise<RuntimePaths> {
  if (pythonRuntimePaths) return pythonRuntimePaths
  if (runtimeManifestError && app.isPackaged) throw new Error(runtimeManifestError)
  if (!pythonRuntime) throw new Error('Python runtime is not initialized')
  pythonRuntimePaths = await pythonRuntime.ensureReady()
  return pythonRuntimePaths
}

export interface PublicKnowledgeCollection {
  collectionId: string
  displayName: string
  directory: string
  indexState: CollectionRecord['indexState']
  lastIndexedAt: string | null
}

export interface PublicKnowledgeSnapshot {
  state: string
  model: KnowledgeModelStatus
  collections: PublicKnowledgeCollection[]
}

export interface KnowledgeIpcHandlers {
  snapshot(): Promise<PublicKnowledgeSnapshot>
  addCollection(): Promise<PublicKnowledgeSnapshot>
  removeCollection(collectionId: unknown): Promise<PublicKnowledgeSnapshot>
  reindex(collectionId: unknown, confirmed?: unknown): Promise<PublicKnowledgeSnapshot>
  deleteIndex(collectionId: unknown): Promise<PublicKnowledgeSnapshot>
  cancel(): void
}

interface KnowledgeIpcDependencies {
  service: {
    snapshot: () => Promise<KnowledgeSnapshot>
    addCollection: (root: string) => Promise<unknown>
    removeCollection: (collectionId: string) => Promise<void>
    reindex: (collectionId: string, confirmed?: boolean) => Promise<void>
    deleteIndex: (collectionId: string) => Promise<void>
  }
  pickDirectory: () => Promise<{ canceled: boolean; filePaths: string[] }>
  modelStatus: () => Promise<KnowledgeModelStatus>
  cancel: () => void
}

function publicKnowledgeSnapshot(snapshot: KnowledgeSnapshot, model: KnowledgeModelStatus): PublicKnowledgeSnapshot {
  const reason = sanitizePublicReason(snapshot.state.reason)
  return {
    state: snapshot.state.name,
    ...(reason ? { reason } : {}),
    model: publicModelStatus(model),
    collections: snapshot.collections.map((collection) => ({
      collectionId: collection.collectionId,
      displayName: collection.displayName,
      directory: collection.root,
      indexState: collection.indexState,
      lastIndexedAt: collection.lastIndexedAt,
    })),
  }
}

function assertCollectionId(value: unknown): string {
  if (typeof value !== 'string' || !COLLECTION_ID.test(value)) throw new Error('Invalid knowledge collection')
  return value
}

function mapKnowledgeIpcError(error: unknown): Error {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
  const messages: Record<string, string> = {
    collection_limit: '知识库最多支持 32 个已启用目录',
    collection_exists: '该知识库目录已经添加',
    collection_invalid: '知识库目录无效',
    operation_in_progress: '知识库已有操作正在进行',
  }
  return new Error(messages[code] ?? (error instanceof Error ? error.message : '知识库操作失败'))
}

/** Main-process-only adapter for the fixed, renderer-safe knowledge IPC contract. */
export function createKnowledgeIpcHandlers(dependencies: KnowledgeIpcDependencies): KnowledgeIpcHandlers {
  const snapshot = async (): Promise<PublicKnowledgeSnapshot> => publicKnowledgeSnapshot(
    await dependencies.service.snapshot(),
    await dependencies.modelStatus(),
  )
  return {
    snapshot,
    async addCollection(): Promise<PublicKnowledgeSnapshot> {
      try {
        const result = await dependencies.pickDirectory()
        if (!result.canceled && result.filePaths.length === 1 && typeof result.filePaths[0] === 'string') {
          await dependencies.service.addCollection(result.filePaths[0])
        }
        return snapshot()
      } catch (error) {
        throw mapKnowledgeIpcError(error)
      }
    },
    async removeCollection(collectionId: unknown): Promise<PublicKnowledgeSnapshot> {
      try {
        await dependencies.service.removeCollection(assertCollectionId(collectionId))
        return snapshot()
      } catch (error) {
        throw mapKnowledgeIpcError(error)
      }
    },
    async reindex(collectionId: unknown, confirmed?: unknown): Promise<PublicKnowledgeSnapshot> {
      try {
        await dependencies.service.reindex(assertCollectionId(collectionId), confirmed === true)
        return snapshot()
      } catch (error) {
        throw mapKnowledgeIpcError(error)
      }
    },
    async deleteIndex(collectionId: unknown): Promise<PublicKnowledgeSnapshot> {
      try {
        await dependencies.service.deleteIndex(assertCollectionId(collectionId))
        return snapshot()
      } catch (error) {
        throw mapKnowledgeIpcError(error)
      }
    },
    cancel: () => dependencies.cancel(),
  }
}

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
  if (voiceOwnsVisibility) return
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
    // 安全：只允许读皮肤目录内的文件（相对路径不得越界到目录外）
    const rel = relative(skin.directory, target)
    if (rel.startsWith('..') || isAbsolute(rel)) {
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

function setSecurityVisibility(locked: boolean): void {
  if (locked) {
    clearHideTimer()
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide()
    }
    return
  }
  recordActivity()
  showOrb()
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
  const runtime = await ensurePythonRuntime()
  gateway = new EmbeddedGateway({
    port: settings.gatewayPort,
    runtime,
    mode: app.isPackaged ? 'packaged' : 'development',
  })
  const url = await gateway.start()
  console.log(`[desktop] gateway ready at ${url}`)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gateway:ready', url)
  }
}

async function startKnowledgeProxy(): Promise<void> {
  if (knowledgeProxy && knowledgeProxyEndpoint) return
  if (!knowledgeService) throw new Error('Knowledge service is not initialized')
  const proxy = new QmdProxy({ service: knowledgeService })
  const endpoint = await proxy.start()
  knowledgeProxy = proxy
  knowledgeProxyEndpoint = endpoint
}

async function startVoice(): Promise<void> {
  const settings = settingsStore?.get()
  if (!settings?.enableVoice) return
  if (['responses-api', 'chat-completions'].includes(settings.llmBackend) && !secretStore?.isAvailable()) {
    throw new Error('Secure credential storage is unavailable')
  }
  voiceOwnsVisibility = shouldDelegateOrbSleepToVoice({
    enableVoice: settings.enableVoice,
    wakeWordEnabled: settings.wakeWordEnabled,
    autoHideSeconds: settings.autoHideSeconds,
  })
  if (voiceOwnsVisibility) {
    clearHideTimer()
  }
  const runtime = await ensurePythonRuntime()
  pushVoiceStatus('starting')
  const v = new EmbeddedVoice({
    runtime,
    mode: app.isPackaged ? 'packaged' : 'development',
    wakeWordEnabled: settings.wakeWordEnabled,
    wakeWord: settings.wakeWord,
    securityTimeoutS: settings.autoHideSeconds,
    gatewayUrl: gatewayUrl() ?? 'http://127.0.0.1:3101',
    qmdProxyUrl: knowledgeProxyEndpoint?.url,
    qmdProxyToken: knowledgeProxyEndpoint?.token,
    voiceprintEnabled: settings.enableVoiceprint,
    voiceprintThreshold: settings.voiceprintThreshold,
    llmBackend: settings.llmBackend,
    llmApiKey: secretStore?.getLlmApiKey() ?? '',
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    sttBackend: settings.sttBackend,
    sttModel: settings.sttModel,
    sttHotwords: settings.sttHotwords,
    ttsBackend: settings.ttsBackend,
    ttsVoice: settings.ttsVoice,
    llmReasoningEffort: settings.llmReasoningEffort,
    memoryEnabled: settings.memoryEnabled,
    memoryCloudConsent: settings.memoryCloudConsent,
    memorySidecarPython: settings.memorySidecarPython,
    memorySidecarScript: settings.memorySidecarScript,
    memoryRoot: join(app.getPath('userData'), 'memory'),
    memoryMaxChars: settings.memoryMaxChars,
    onLog: (line) => pushVoiceLog(line),
    onEvent: (event) => {
      const state = voiceStateFromEvent(event)
      if (state && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice:state', state)
      }
      if (state && isVoiceActivityState(state)) {
        if (!voiceOwnsVisibility) {
          showOrb()
        }
        recordActivity()
      }
    },
    onSecurityState: (locked) => setSecurityVisibility(locked),
  })
  voice = v
  try {
    await v.start()
    pushVoiceStatus('running')
    console.log('[desktop] voice engine ready')
    // 引擎就绪后，补发引擎未就绪期间堆积的任务播报。
    for (const text of pendingSpeak) v.speak(text)
    pendingSpeak = []
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice:ready', true)
    }
  } catch (error) {
    voice = null
    voiceOwnsVisibility = false
    recordActivity()
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

/** 摘要截断：按句子边界截断，避免念一半断句。 */
function summarize(text: string | undefined, max = 120): string {
  const s = (text || '').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  // 在 max 内找最后一个句子结束符（。！？!?；;\n）
  const ends = ['。', '！', '？', '!', '?', '；', ';', '\n']
  let last = -1
  for (const ch of ends) last = Math.max(last, cut.lastIndexOf(ch))
  if (last >= Math.floor(max * 0.4)) {
    return `${s.slice(0, last + 1)}……`
  }
  return `${cut}……`
}

/** 用远程 LLM 把任务结果概括成一句话；失败或本地后端时回退到句子截断。 */
async function summarizeTaskResult(text: string | undefined): Promise<string> {
  const s = (text || '').trim()
  if (!s) return ''
  const settings = settingsStore?.get()
  const remote = settings && ['responses-api', 'chat-completions'].includes(settings.llmBackend)
  if (!remote || !settings) return summarize(s)
  const baseUrl = (settings.llmBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const url = `${baseUrl}/chat/completions`
  const key = secretStore?.getLlmApiKey() || process.env.OPENAI_API_KEY || 'none'
  const body: Record<string, unknown> = {
    model: settings.llmModel || 'gpt-5.4-mini',
    messages: [
      {
        role: 'user',
        content: `请用一句话（不超过50字）简洁概括下面任务结果的核心结论，只输出概括本身：\n\n${s}`,
      },
    ],
    stream: false,
  }
  if (settings.llmReasoningEffort && settings.llmReasoningEffort !== 'none') {
    body.reasoning_effort = settings.llmReasoningEffort
  } else {
    body.chat_template_kwargs = { enable_thinking: false }
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!resp.ok) {
      console.error(`[desktop] 任务总结 LLM 请求失败: ${resp.status} ${await resp.text().catch(() => '')}`)
      return summarize(s)
    }
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const summary = data.choices?.[0]?.message?.content?.trim()
    console.log(`[desktop] 任务总结 LLM 返回: ${summary?.slice(0, 80) ?? '（空）'}`)
    if (!summary) return summarize(s)
    return summary.length > 150 ? summarize(summary, 150) : summary
  } catch (error) {
    console.error('[desktop] 任务总结 LLM 调用异常:', error)
    return summarize(s)
  }
}

/** 记录已播报的任务 id；超过上限时淘汰最旧，防止无限增长。 */
function rememberAnnouncedTask(id: string): void {
  announcedTaskIds.add(id)
  if (announcedTaskIds.size > 1000) {
    const oldest = announcedTaskIds.values().next().value
    if (oldest !== undefined) announcedTaskIds.delete(oldest)
  }
}

/** 任务完成/失败/取消时：系统通知 + Qwen3 语音播报。 */
async function announceTaskCompletion(task: Record<string, unknown>): Promise<void> {
  const id = String(task.id || '')
  if (!id || announcedTaskIds.has(id)) return
  rememberAnnouncedTask(id)
  const status = String(task.status || '')
  let body = ''
  if (status === 'completed') {
    body = `任务已完成：${await summarizeTaskResult(task.result as string | undefined)}`
  } else if (status === 'failed') {
    body = `任务执行失败：${summarize(task.error as string | undefined)}`
  } else if (status === 'cancelled') {
    body = '任务已取消'
  } else {
    return
  }
  notify('speech-to-speech', body)
  if (voice?.running) {
    voice.speak(body)
  } else {
    pendingSpeak.push(body)
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
        if (task) void announceTaskCompletion(task)
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

async function toggleVoice(): Promise<{ running: boolean; starting: boolean }> {
  if (voice) {
    if (voice.running) {
      await voice.stop()
      voice = null
      voiceOwnsVisibility = false
      recordActivity()
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

/** spawn 一个 voiceprint 子命令，stdout/stderr 实时推送给设置窗口。 */
async function runVoiceprintCommand(args: string[]): Promise<{ ok: boolean; output: string }> {
  const runtime = await ensurePythonRuntime()
  return new Promise((resolvePromise) => {
    const child = spawn(runtime.python, args, { cwd: runtime.appRoot })
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

interface VoiceprintStatus {
  enrolled: boolean
  supportsContinuous: boolean
  protocol: string | null
  model: string | null
  takes: number
  totalDurationS: number
  path: string
}

/** 读取声纹档案元信息（JSON）；文件不存在或解析失败返回 null。 */
async function runVoiceprintInfoJson(): Promise<Record<string, unknown> | null> {
  const runtime = await ensurePythonRuntime()
  return new Promise((resolvePromise) => {
    const child = spawn(
      runtime.python,
      ['-m', 'speech_to_speech.cli', 'voiceprint', 'info', '--json', '--profile', voiceprintPath()],
      { cwd: runtime.appRoot },
    )
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('close', (code) => {
      if (code !== 0) {
        resolvePromise(null)
        return
      }
      const trimmed = output.trim()
      if (!trimmed) {
        resolvePromise(null)
        return
      }
      try {
        resolvePromise(JSON.parse(trimmed) as Record<string, unknown>)
      } catch {
        resolvePromise(null)
      }
    })
  })
}

async function voiceprintStatusPayload(): Promise<VoiceprintStatus> {
  const path = voiceprintPath()
  if (!existsSync(path)) {
    return { enrolled: false, supportsContinuous: false, protocol: null, model: null, takes: 0, totalDurationS: 0, path }
  }
  const info = await runVoiceprintInfoJson()
  if (!info) {
    return { enrolled: true, supportsContinuous: false, protocol: 'unknown', model: null, takes: 0, totalDurationS: 0, path }
  }
  return {
    enrolled: true,
    supportsContinuous: info.supports_continuous_gating === true,
    protocol: typeof info.enrollment_protocol === 'string' ? info.enrollment_protocol : null,
    model: typeof info.model === 'string' ? info.model : null,
    takes: typeof info.takes === 'number' ? info.takes : 0,
    totalDurationS: typeof info.total_duration_s === 'number' ? info.total_duration_s : 0,
    path,
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

if (process.argv.includes('--package-verify')) {
  const packageVerifyEntry = new URL('./packageVerify.js', import.meta.url).href
  void import(packageVerifyEntry).catch(() => {
    process.stderr.write('PACKAGE_VERIFY_FAILED:runtime\n')
    process.exitCode = 1
  })
} else {
app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }

  settingsStore = new SettingsStore()
  secretStore = new SecretStore(join(app.getPath('userData'), 'secrets.json'))
  if (secretStore.isAvailable()) settingsStore.migrateLegacyLlmApiKey(secretStore)
  const qmdResourceRoot = app.isPackaged ? join(process.resourcesPath, 'qmd') : join(__dirname, '../..')
  knowledgeService = new QmdService({
    metadataPath: join(app.getPath('userData'), 'knowledge', 'collections.json'),
    runner: new QmdIndexer({ resourceRoot: qmdResourceRoot, dataRoot: app.getPath('userData') }),
  })
  const runtimeManifestResult = loadRuntimeManifest()
  const runtimeManifest = runtimeManifestResult.manifest
  runtimeManifestError = runtimeManifestResult.error ?? null
  pythonRuntime = new PythonRuntime({
    userDataDir: app.getPath('userData'),
    manifest: runtimeManifest,
    packagedRoot: app.isPackaged ? join(process.resourcesPath, 'runtime') : undefined,
    devRoot: app.isPackaged ? undefined : resolve(__dirname, '../../..'),
  })
  const modelAsset = runtimeManifest.assets.find((asset) => asset.kind === 'model' && (asset.role === 'embedding' || asset.id === 'embedding'))
  const retrievalProfiles = getRetrievalProfiles(runtimeManifest)
  const indexFingerprints: Partial<Record<'vec-only' | 'hybrid', string>> = {}
  if (retrievalProfiles.vecOnly) indexFingerprints['vec-only'] = getIndexFingerprint(runtimeManifest, retrievalProfiles.vecOnly, '2.8.3')
  if (retrievalProfiles.hybrid) indexFingerprints.hybrid = getIndexFingerprint(runtimeManifest, retrievalProfiles.hybrid, '2.8.3')
  const configuredRetrievalPreference = settingsStore?.get().knowledgeRetrievalMode ?? 'auto'
  const effectiveRetrievalPreference = (configuredRetrievalPreference === 'hybrid' || configuredRetrievalPreference === 'full') && !retrievalProfiles.hybrid
    ? 'auto'
    : configuredRetrievalPreference
  if (effectiveRetrievalPreference !== configuredRetrievalPreference) {
    settingsStore?.save({ knowledgeRetrievalMode: effectiveRetrievalPreference })
  }
  const qmdRuntime = new QmdRuntime({ resourceRoot: qmdResourceRoot, dataRoot: app.getPath('userData') })
  const qmdClient = new QmdMcpClient({ endpoint: () => qmdRuntime.endpoint?.baseUrl ?? '' })
  runtimeManager = new RuntimeManager({
    service: knowledgeService,
    modelStore: new ModelStore({ root: app.getPath('userData'), manifest: runtimeManifest }),
    modelAssetId: modelAsset?.id ?? 'embedding',
    modelDownloadBytes: modelAsset?.size ?? 0,
    modelDiskBytes: modelAsset?.size ?? 0,
    modelAssetSizes: Object.fromEntries(runtimeManifest.assets.filter((asset) => asset.kind === 'model').map((asset) => [asset.id, asset.size])),
    retrievalProfiles,
    indexFingerprints,
    retrievalPreference: effectiveRetrievalPreference,
    preheatEnabled: settingsStore?.get().knowledgePreheatEnabled ?? true,
    modelUnavailableReason: app.isPackaged ? runtimeManifestResult.error : undefined,
    qmdRuntime,
    qmdClient,
    invalidateHandles: () => knowledgeProxy?.invalidateHandles(),
  })
  runtimeManager.subscribe((snapshot) => pushKnowledgeSnapshot(snapshot))
  if (runtimeManifestResult.error) {
    console.error('[desktop] 知识库运行时不可用：', runtimeManifestResult.error)
  }
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
  ipcMain.handle('voiceprint:status', () => voiceprintStatusPayload())
  ipcMain.handle('voiceprint:enroll', () => {
    const wakeWord = settingsStore?.get().wakeWord || '你好，噜噜'
    return runVoiceprintCommand([
      '-m', 'speech_to_speech.cli', 'voiceprint', 'enroll',
      '--wake-word', wakeWord,
    ])
  })
  ipcMain.handle('voiceprint:verify', () => {
    return runVoiceprintCommand(['-m', 'speech_to_speech.cli', 'voiceprint', 'verify'])
  })
  ipcMain.handle('settings:get', () => ({
    ...(settingsStore?.get() ?? {}),
    llmApiKeyPresent: secretStore?.hasLlmApiKey() ?? false,
  }))
  ipcMain.handle('settings:set-secret', async (_e, value: unknown) => {
    if (typeof value !== 'string') throw new Error('Invalid API key')
    secretStore?.setLlmApiKey(value)
    if (voice) {
      const runningVoice = voice
      voice = null
      await runningVoice.stop()
      void startVoice().catch(() => undefined)
    }
    return { llmApiKeyPresent: secretStore?.hasLlmApiKey() ?? false }
  })
  ipcMain.handle('settings:clear-secret', async () => {
    secretStore?.clearLlmApiKey()
    if (voice) {
      const runningVoice = voice
      voice = null
      await runningVoice.stop()
      void startVoice().catch(() => undefined)
    }
    return { llmApiKeyPresent: false }
  })
  ipcMain.handle('settings:save', async (_e, settings: Record<string, unknown>) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings')
    const candidate = settings as Partial<DesktopSettings>
    if (candidate.enableVoiceprint === true) {
      const status = await voiceprintStatusPayload()
      if (!status.enrolled) throw new Error('请先注册声纹，再启用声纹验证')
      if (!status.supportsContinuous) throw new Error('当前声纹档案为旧版（仅唤醒词），请重新注册后再启用')
    }
    if ((candidate.knowledgeRetrievalMode === 'hybrid' || candidate.knowledgeRetrievalMode === 'full') && !getRetrievalProfiles(runtimeManifest).hybrid) {
      throw new Error('当前运行时未提供可用的混合检索模型')
    }
    const before = settingsStore?.get()
    const saved = settingsStore?.save(settings)
    if (saved && runtimeManager) {
      if (!before || before.knowledgeRetrievalMode !== saved.knowledgeRetrievalMode) {
        await runtimeManager.setRetrievalPreference(saved.knowledgeRetrievalMode)
      }
      runtimeManager.setPreheatEnabled(saved.knowledgePreheatEnabled)
    }
    // 皮肤变化 → 重载 orb 让新皮肤生效
    if (before && saved && candidate.orbSkin !== undefined && before.orbSkin !== saved.orbSkin) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.reload()
      }
    }
    // 快捷键变化 → 重新注册
    if (before && saved && candidate.wakeShortcut !== undefined && before.wakeShortcut !== saved.wakeShortcut) {
      globalShortcut.unregister(before.wakeShortcut)
      registerWakeShortcut(saved.wakeShortcut)
    }
    // 语音/网关相关字段变化 → 运行中的子进程需要重启才生效
    if (before && saved) {
      const enableChanged =
        candidate.enableVoice !== undefined && before.enableVoice !== saved.enableVoice
      const voiceChanged = VOICE_AFFECTING_FIELDS.some(
        (f) => candidate[f] !== undefined && before[f] !== saved[f],
      )
      const gatewayPortChanged =
        candidate.gatewayPort !== undefined && before.gatewayPort !== saved.gatewayPort
      try {
        if (gatewayPortChanged && gateway) {
          await gateway.stop()
          gateway = null
          void startGateway().catch((error) => {
            console.error('[desktop] Gateway 重启失败：', error)
          })
        }
        if (enableChanged) {
          if (saved.enableVoice) {
            void startVoice().catch((error) => {
              console.error('[desktop] 语音引擎启动失败：', error)
            })
          } else if (voice) {
            await voice.stop()
            voice = null
            voiceOwnsVisibility = false
            recordActivity()
          }
        } else if (voiceChanged && voice) {
          pushVoiceStatus('starting')
          const v = voice
          voice = null
          voiceOwnsVisibility = false
          await v.stop()
          recordActivity()
          void startVoice().catch((error) => {
            console.error('[desktop] 语音引擎重启失败：', error)
          })
        }
      } catch (error) {
        console.error('[desktop] 设置变更后重启子进程失败：', error)
      }
    }
    recordActivity()
    return { ...(saved ?? {}), llmApiKeyPresent: secretStore?.hasLlmApiKey() ?? false }
  })
  const knowledgeHandlers = createKnowledgeIpcHandlers({
    service: runtimeManager!,
    pickDirectory: () => dialog.showOpenDialog(settingsWindow ?? mainWindow!, {
      title: '选择知识库目录',
      properties: ['openDirectory'],
    }),
    modelStatus: () => runtimeManager!.modelStatus(),
    cancel: () => runtimeManager!.cancel(),
  })
  ipcMain.handle('knowledge:snapshot', () => knowledgeHandlers.snapshot())
  ipcMain.handle('knowledge:add-collection', () => knowledgeHandlers.addCollection())
  ipcMain.handle('knowledge:remove-collection', (_event, collectionId: unknown) => knowledgeHandlers.removeCollection(collectionId))
  ipcMain.handle('knowledge:reindex', (_event, collectionId: unknown, confirmed: unknown) => knowledgeHandlers.reindex(collectionId, confirmed))
  ipcMain.handle('knowledge:delete-index', (_event, collectionId: unknown) => knowledgeHandlers.deleteIndex(collectionId))
  ipcMain.handle('knowledge:cancel', () => knowledgeHandlers.cancel())
  ipcMain.handle('knowledge:state', () => knowledgeHandlers.snapshot())
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

  void startProcessesInOrder({
    gateway: startGateway,
    subscribeGatewayEvents,
    proxy: startKnowledgeProxy,
    restoreIndexes: () => runtimeManager?.restoreExistingIndexes() ?? Promise.resolve(),
    voice: startVoice,
  })
    .catch((error) => {
      console.error('[desktop] 服务启动失败：', error)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gateway:error', String(error))
      }
    })

  app.on('activate', () => showOrb())
})
}

app.on('window-all-closed', () => {
  console.log('[desktop] window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  console.log('[desktop] before-quit fired (gateway=%s voice=%s)', !!gateway, !!voice)
})

app.on('will-quit', (event) => {
  console.log('[desktop] will-quit fired (gateway=%s proxy=%s voice=%s)', !!gateway, !!knowledgeProxy, !!voice)
  globalShortcut.unregisterAll()
  clearHideTimer()
  gatewayWs?.close()
  gatewayWs = null
  if (!gateway && !knowledgeProxy && !voice) return
  event.preventDefault()
  const stoppingVoice = voice
  const stoppingProxy = knowledgeProxy
  const stoppingGateway = gateway
  const stoppingRuntime = runtimeManager
  voice = null
  knowledgeProxy = null
  knowledgeProxyEndpoint = null
  gateway = null
  runtimeManager = null
  void stopProcessesInOrder({
    voice: stoppingVoice ? () => stoppingVoice.stop() : undefined,
    proxy: stoppingProxy ? () => stoppingProxy.stop() : undefined,
    qmd: stoppingRuntime ? () => stoppingRuntime.stop() : undefined,
    gateway: stoppingGateway ? () => stoppingGateway.stop() : undefined,
  }).then(() => {
    app.quit()
  })
})
