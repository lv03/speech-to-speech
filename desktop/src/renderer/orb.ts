import { SpriteRenderer } from './sprite-renderer'
import type { OrbState, SkinManifest } from './sprite-orb'

interface TaskView {
  id: string
  kind: string
  status: string
  prompt: string
  result?: string
  error?: string
  created_at?: number
  tool_calls?: Array<{ name: string; status: string }>
}

const orb = document.getElementById('orb')!
const orbStatus = document.getElementById('orb-status')!
const orbStage = document.getElementById('orb-stage')!
const spriteCanvas = document.getElementById('sprite-canvas') as HTMLCanvasElement
const taskStack = document.getElementById('task-stack')!
const btnMic = document.getElementById('btn-mic') as HTMLButtonElement
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement
const btnTasks = document.getElementById('btn-tasks') as HTMLButtonElement
const btnQuit = document.getElementById('btn-quit') as HTMLButtonElement

let gatewayUrl: string | null = null
let ws: WebSocket | null = null
let spriteRenderer: SpriteRenderer | null = null
let voiceState: OrbState = 'idle'
let busy = false
let tasks: TaskView[] = []
let tasksCollapsed = false

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  cancelling: '取消中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_CLASS: Record<string, string> = {
  queued: 'running',
  running: 'running',
  cancelling: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

function updateOrbState(): void {
  if (!spriteRenderer) return
  if (voiceState !== 'idle') {
    spriteRenderer.setState(voiceState)
  } else if (busy) {
    spriteRenderer.setState('working')
  } else {
    spriteRenderer.setState('idle')
  }
}

function updateOrbStateFromTasks(): void {
  busy = tasks.some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'cancelling')
  updateOrbState()
}

function relativeTime(ts?: number): string {
  if (!ts) return ''
  const diff = Math.floor(Date.now() / 1000 - ts)
  if (diff < 60) return `${diff}秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  return `${Math.floor(diff / 3600)}小时前`
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 可点击展开/收起的文本块。 */
function makeExpandable(text: string, className: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `${className} expandable`
  el.dataset.full = text
  el.dataset.collapsed = '1'
  el.textContent = truncate(text)
  el.title = '点击展开/收起'
  el.addEventListener('click', () => {
    const collapsed = el.dataset.collapsed === '1'
    el.dataset.collapsed = collapsed ? '0' : '1'
    el.textContent = collapsed ? el.dataset.full ?? '' : truncate(el.dataset.full ?? '')
    el.classList.toggle('expanded', collapsed)
  })
  return el
}

function renderTasks(): void {
  taskStack.innerHTML = ''
  for (const task of tasks) {
    const card = document.createElement('article')
    card.className = 'task-card'

    // 头部：kind 徽章 + 状态 + 时间
    const header = document.createElement('div')
    header.className = 'task-head'
    const kind = document.createElement('span')
    kind.className = 'task-kind'
    kind.textContent = task.kind === 'codex' ? 'codex' : 'pi'
    const state = document.createElement('span')
    state.className = 'task-state'
    const dot = document.createElement('i')
    dot.className = STATUS_CLASS[task.status] ?? 'running'
    const label = document.createElement('small')
    label.textContent = STATUS_LABEL[task.status] ?? task.status
    state.append(dot, label)
    const time = document.createElement('small')
    time.className = 'task-time'
    time.textContent = relativeTime(task.created_at)
    header.append(kind, state, time)
    card.appendChild(header)

    // 标题：prompt（可展开）
    card.appendChild(makeExpandable(task.prompt || '', 'task-title'))

    // 结果 / 错误（可展开）
    if (task.status === 'completed' && task.result) {
      card.appendChild(makeExpandable(task.result, 'task-result'))
    } else if (task.status === 'failed' && task.error) {
      card.appendChild(makeExpandable(task.error, 'task-error'))
    }

    // 工具调用 chip
    const tools = task.tool_calls || []
    if (tools.length > 0) {
      const toolRow = document.createElement('div')
      toolRow.className = 'task-tools'
      for (const t of tools.slice(0, 6)) {
        const chip = document.createElement('span')
        chip.className = 'task-tool'
        chip.textContent = t.name
        chip.title = `${t.name}（${t.status}）`
        toolRow.appendChild(chip)
      }
      if (tools.length > 6) {
        const more = document.createElement('span')
        more.className = 'task-tool more'
        more.textContent = `+${tools.length - 6}`
        toolRow.appendChild(more)
      }
      card.appendChild(toolRow)
    }

    // 进度条（仅在非终结态）
    if (task.status === 'queued' || task.status === 'running' || task.status === 'cancelling') {
      const progress = document.createElement('div')
      progress.className = 'task-progress'
      const bar = document.createElement('span')
      if (task.status === 'queued' || task.status === 'cancelling') {
        progress.classList.add('indeterminate')
      }
      progress.appendChild(bar)
      card.appendChild(progress)
    }

    taskStack.appendChild(card)
  }
  // 折叠状态 + 通知主进程调整窗口尺寸
  taskStack.classList.toggle('hidden', tasksCollapsed && tasks.length > 0)
  btnTasks.classList.toggle('hidden', tasks.length === 0)
  window.desktop.setTaskCount(tasksCollapsed ? 0 : tasks.length)
}

function connectEvents(url: string): void {
  const wsUrl = url.replace(/^http/, 'ws') + '/events'
  // 主动关闭旧连接：旧 socket 的 onclose 会被 ws !== socket 拦截，不会触发重连
  ws?.close()
  const socket = new WebSocket(wsUrl)
  ws = socket
  socket.onopen = () => {
    orbStatus.className = 'orb-status ok'
    orbStatus.title = 'Gateway 已连接'
  }
  socket.onclose = () => {
    // 已被更新的连接替换时，重连由新连接负责，这里直接退出
    if (ws !== socket) return
    ws = null
    orbStatus.className = 'orb-status error'
    orbStatus.title = 'Gateway 连接断开'
    // 断线重连（仅当仍是最新连接且 gateway 地址未变化）
    setTimeout(() => {
      if (gatewayUrl && !ws) connectEvents(gatewayUrl)
    }, 3000)
  }
  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string)
      if (msg.event === 'snapshot') {
        tasks = msg.tasks as TaskView[]
        renderTasks()
        updateOrbStateFromTasks()
      } else if (msg.event === 'status') {
        const task = msg.data?.task as TaskView | null
        if (task) {
          const index = tasks.findIndex((t) => t.id === task.id)
          if (index >= 0) tasks[index] = task
          else tasks.push(task)
          renderTasks()
          updateOrbStateFromTasks()
        }
      }
    } catch {
      // 忽略无法解析的消息
    }
  }
}

async function refreshTasks(): Promise<void> {
  try {
    tasks = (await window.desktop.listTasks()) as TaskView[]
    renderTasks()
    updateOrbStateFromTasks()
  } catch {
    // Gateway 未就绪
  }
}

// ── 控制交互 ────────────────────────────────────────────────────────────

function toggleVoice(): void {
  btnMic.disabled = true
  btnMic.classList.add('loading')
  btnMic.title = '语音引擎启动中…'
  void window.desktop.toggleVoice().then((result) => {
    const r = result as { running: boolean; starting: boolean }
    if (r.starting) {
      // 后台启动中，等待 voice:ready / voice:error 事件；
      // 兜底：事件若在订阅前已发出（如页面 reload 后引擎已在运行），
      // 延迟轮询一次把按钮恢复成真实状态，避免永久卡在 loading。
      setTimeout(() => void refreshVoiceStatus(), 2000)
      return
    }
    btnMic.classList.toggle('active', r.running)
    btnMic.title = r.running ? '关闭语音引擎' : '开启语音引擎'
    btnMic.classList.remove('loading')
    btnMic.disabled = false
  }).catch(() => {
    btnMic.classList.remove('active', 'loading')
    btnMic.disabled = false
    btnMic.title = '开启语音引擎'
  })
}

// 语音引擎就绪 / 错误事件
window.desktop.onVoiceReady(() => {
  btnMic.classList.add('active')
  btnMic.classList.remove('loading')
  btnMic.disabled = false
  btnMic.title = '关闭语音引擎'
  orbStatus.className = 'orb-status ok'
})
window.desktop.onVoiceError((message) => {
  btnMic.classList.remove('active', 'loading')
  btnMic.disabled = false
  btnMic.title = `语音引擎启动失败：${message}`
  orbStatus.className = 'orb-status error'
})

async function refreshVoiceStatus(): Promise<void> {
  try {
    const status = (await window.desktop.voiceStatus()) as { running: boolean }
    btnMic.classList.toggle('active', status.running)
    btnMic.classList.remove('loading')
    btnMic.disabled = false
    btnMic.title = status.running ? '关闭语音引擎' : '开启语音引擎'
  } catch {
    btnMic.classList.remove('active', 'loading')
    btnMic.disabled = false
    btnMic.title = '开启语音引擎'
  }
}

orb.addEventListener('click', () => {
  window.desktop.reportActivity()
  toggleVoice()
})
btnMic.addEventListener('click', () => toggleVoice())
btnSettings.addEventListener('click', () => window.desktop.openSettings())
btnTasks.addEventListener('click', () => {
  tasksCollapsed = !tasksCollapsed
  renderTasks()
})
btnQuit.addEventListener('click', () => window.desktop.quit())

// ── 语音状态 ────────────────────────────────────────────────────────────

window.desktop.onVoiceState((state) => {
  voiceState = (state as OrbState) || 'idle'
  updateOrbState()
})

// ── 皮肤 ────────────────────────────────────────────────────────────────

async function initSkin(): Promise<void> {
  try {
    const settings = (await window.desktop.getSettings()) as Record<string, unknown>
    const orbSkin = String(settings.orbSkin || '').trim()
    if (!orbSkin) return
    const skins = (await window.desktop.listSkins()) as Array<{
      id: string
      spriteVersionNumber: number
      frame: { width: number; height: number; columns: number; rows: number }
      spritesheetUrl: string
    }>
    const skin = skins.find((s) => s.id === orbSkin)
    if (!skin) return
    const manifest: SkinManifest = {
      spriteVersionNumber: skin.spriteVersionNumber,
      frame: skin.frame,
    }
    const renderer = new SpriteRenderer(spriteCanvas, manifest, skin.spritesheetUrl)
    await renderer.load()
    spriteRenderer = renderer
    spriteCanvas.classList.remove('hidden')
    orb.classList.add('hidden')
  } catch (error) {
    console.error('皮肤加载失败，回退默认球：', error)
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────

window.desktop.onGatewayReady((url) => {
  if (gatewayUrl !== url) {
    gatewayUrl = url
    connectEvents(url)
    void refreshTasks()
  }
})

void (async () => {
  void initSkin()
  void refreshVoiceStatus()
  const url = await window.desktop.getGatewayUrl()
  if (url) {
    gatewayUrl = url
    connectEvents(url)
    void refreshTasks()
  }
})()
