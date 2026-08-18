import { SpriteRenderer } from './sprite-renderer'
import type { SkinManifest } from './sprite-orb'

interface TaskView {
  id: string
  kind: string
  status: string
  prompt: string
  result?: string
  error?: string
}

const orb = document.getElementById('orb')!
const spriteCanvas = document.getElementById('sprite-canvas') as HTMLCanvasElement
const panel = document.getElementById('panel')!
const orbStatus = document.getElementById('orb-status')!
const gatewayStatus = document.getElementById('gateway-status')!
const taskList = document.getElementById('task-list')!
const taskInput = document.getElementById('task-input') as HTMLInputElement
const taskSend = document.getElementById('task-send') as HTMLButtonElement

const STATUS_COLORS: Record<string, string> = {
  queued: '#f59e0b',
  running: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
  cancelling: '#f59e0b',
  cancelled: '#9ca3af',
}

let gatewayUrl: string | null = null
let ws: WebSocket | null = null

function setOrbColor(color: string): void {
  orbStatus.style.backgroundColor = color
}

function renderTasks(tasks: TaskView[]): void {
  taskList.innerHTML = ''
  for (const task of tasks) {
    const item = document.createElement('div')
    item.className = 'task-item'
    const dot = document.createElement('span')
    dot.className = 'task-dot'
    dot.style.backgroundColor = STATUS_COLORS[task.status] ?? '#9ca3af'
    const text = document.createElement('span')
    text.className = 'task-text'
    const body = task.status === 'completed' ? task.result || task.prompt : task.prompt
    text.textContent = `[${task.status}] ${body}`
    item.append(dot, text)
    taskList.appendChild(item)
  }
}

async function refreshTasks(): Promise<void> {
  const tasks = (await window.desktop.listTasks()) as TaskView[]
  renderTasks(tasks)
}

function connectEvents(url: string): void {
  const wsUrl = url.replace(/^http/, 'ws') + '/events'
  ws = new WebSocket(wsUrl)
  ws.onopen = () => {
    gatewayStatus.textContent = `已连接 ${url}`
    setOrbColor('#22c55e')
  }
  ws.onclose = () => {
    gatewayStatus.textContent = '连接断开'
    setOrbColor('#9ca3af')
  }
  ws.onerror = () => {
    gatewayStatus.textContent = '连接错误'
    setOrbColor('#ef4444')
  }
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string)
      if (msg.event === 'snapshot') {
        renderTasks(msg.tasks as TaskView[])
      } else if (msg.event === 'status') {
        void refreshTasks()
      }
    } catch {
      // 忽略无法解析的消息
    }
  }
}

async function sendTask(): Promise<void> {
  const prompt = taskInput.value.trim()
  if (!prompt) return
  taskInput.value = ''
  try {
    await window.desktop.createTask(prompt, 'pi')
    void refreshTasks()
  } catch (error) {
    gatewayStatus.textContent = `发送失败：${String(error)}`
  }
}

// 点击球体切换面板
orb.addEventListener('click', () => {
  panel.classList.toggle('hidden')
})

/** 加载设置的悬浮球皮肤（pet 包），失败回退默认 CSS 球。 */
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
    spriteCanvas.classList.remove('hidden')
    orb.classList.add('hidden')
  } catch (error) {
    console.error('皮肤加载失败，回退默认球：', error)
  }
}

taskSend.addEventListener('click', () => void sendTask())
taskInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void sendTask()
})

// 启动：监听 gateway 就绪事件，并尝试获取已就绪的 URL
window.desktop.onGatewayReady((url) => {
  if (gatewayUrl !== url) {
    gatewayUrl = url
    connectEvents(url)
    void refreshTasks()
  }
})
void (async () => {
  void initSkin()
  const url = await window.desktop.getGatewayUrl()
  if (url) {
    gatewayUrl = url
    connectEvents(url)
    void refreshTasks()
  } else {
    gatewayStatus.textContent = '正在启动 Gateway…'
    setOrbColor('#f59e0b')
  }
})()
