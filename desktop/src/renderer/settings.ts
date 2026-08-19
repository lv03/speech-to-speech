interface SettingsPayload {
  agentKind: 'pi' | 'codex'
  gatewayPort: number
  enableVoice: boolean
  wakeWordEnabled: boolean
  wakeWord: string
  orbSkin: string
  wakeShortcut: string
  autoHideSeconds: number
  enableVoiceprint: boolean
  llmBackend: string
  llmApiKey: string
  llmBaseUrl: string
  llmModel: string
  sttBackend: string
  sttModel: string
  ttsBackend: string
  ttsVoice: string
  language: string
  llmDisableThinking: boolean
}

// ── DOM 引用 ────────────────────────────────────────────────────────────
const agentKind = document.getElementById('agent-kind') as HTMLSelectElement
const gatewayPort = document.getElementById('gateway-port') as HTMLInputElement
const enableVoice = document.getElementById('enable-voice') as HTMLInputElement
const llmBackend = document.getElementById('llm-backend') as HTMLSelectElement
const llmModel = document.getElementById('llm-model') as HTMLInputElement
const llmApiKey = document.getElementById('llm-api-key') as HTMLInputElement
const llmBaseUrl = document.getElementById('llm-base-url') as HTMLInputElement
const llmDisableThinking = document.getElementById('llm-disable-thinking') as HTMLInputElement
const sttBackend = document.getElementById('stt-backend') as HTMLSelectElement
const sttModel = document.getElementById('stt-model') as HTMLInputElement
const ttsBackend = document.getElementById('tts-backend') as HTMLSelectElement
const ttsVoice = document.getElementById('tts-voice') as HTMLInputElement
const wakeWordEnabled = document.getElementById('wake-word-enabled') as HTMLInputElement
const wakeWord = document.getElementById('wake-word') as HTMLInputElement
const voiceprintEnabled = document.getElementById('voiceprint-enabled') as HTMLInputElement
const orbSkin = document.getElementById('orb-skin') as HTMLSelectElement
const refreshSkinsBtn = document.getElementById('refresh-skins') as HTMLButtonElement
const autoHide = document.getElementById('auto-hide') as HTMLSelectElement
const wakeShortcut = document.getElementById('wake-shortcut') as HTMLInputElement
const language = document.getElementById('language') as HTMLSelectElement
const voiceprintStatusEl = document.getElementById('voiceprint-status')!
const voiceprintEnrollBtn = document.getElementById('voiceprint-enroll') as HTMLButtonElement
const voiceprintVerifyBtn = document.getElementById('voiceprint-verify') as HTMLButtonElement
const voiceprintLog = document.getElementById('voiceprint-log')!
const voiceLog = document.getElementById('voice-log')!
const messageEl = document.getElementById('message')!
const applyButton = document.querySelector('.apply-button') as HTMLButtonElement

// ── Tab 切换 ─────────────────────────────────────────────────────────────
const tabs = Array.from(document.querySelectorAll('.settings-tab')) as HTMLElement[]
const panels = Array.from(document.querySelectorAll('.settings-group')) as HTMLElement[]

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.settingsTab
    tabs.forEach((t) => {
      const active = t === tab
      t.classList.toggle('active', active)
      t.setAttribute('aria-selected', String(active))
    })
    panels.forEach((p) => {
      p.hidden = p.dataset.settingsPanel !== target
    })
  })
})

// ── 渲染/收集 ───────────────────────────────────────────────────────────
function updateLlmFields(): void {
  const remote = ['responses-api', 'chat-completions'].includes(llmBackend.value)
  document.getElementById('llm-base-url-row')!.style.display = remote ? '' : 'none'
  document.getElementById('llm-api-key-row')!.style.display = remote ? '' : 'none'
  document.getElementById('llm-disable-thinking-row')!.style.display = remote ? '' : 'none'
  llmModel.placeholder = remote
    ? '远程模型名（如 gpt-5.4-mini、Qwen3.6）'
    : '本地 HF 模型名（如 mlx-community/Qwen3-4B-Instruct-2507-bf16）'
}

llmBackend.addEventListener('change', updateLlmFields)

function render(settings: SettingsPayload): void {
  agentKind.value = settings.agentKind
  gatewayPort.value = String(settings.gatewayPort)
  enableVoice.checked = settings.enableVoice
  llmBackend.value = settings.llmBackend
  llmModel.value = settings.llmModel
  llmApiKey.value = settings.llmApiKey
  llmBaseUrl.value = settings.llmBaseUrl
  llmDisableThinking.checked = settings.llmDisableThinking
  updateLlmFields()
  sttBackend.value = settings.sttBackend
  sttModel.value = settings.sttModel
  ttsBackend.value = settings.ttsBackend
  ttsVoice.value = settings.ttsVoice
  wakeWordEnabled.checked = settings.wakeWordEnabled
  wakeWord.value = settings.wakeWord
  voiceprintEnabled.checked = settings.enableVoiceprint
  orbSkin.value = settings.orbSkin
  autoHide.value = String(settings.autoHideSeconds ?? 0)
  wakeShortcut.value = settings.wakeShortcut
  language.value = settings.language
}

function collect(): SettingsPayload {
  return {
    agentKind: agentKind.value === 'codex' ? 'codex' : 'pi',
    gatewayPort: Number(gatewayPort.value) || 3101,
    enableVoice: enableVoice.checked,
    llmBackend: llmBackend.value,
    llmModel: llmModel.value.trim(),
    llmApiKey: llmApiKey.value,
    llmBaseUrl: llmBaseUrl.value.trim(),
    llmDisableThinking: llmDisableThinking.checked,
    sttBackend: sttBackend.value,
    sttModel: sttModel.value.trim(),
    ttsBackend: ttsBackend.value,
    ttsVoice: ttsVoice.value.trim(),
    wakeWordEnabled: wakeWordEnabled.checked,
    wakeWord: wakeWord.value.trim() || '噜噜噜噜',
    enableVoiceprint: voiceprintEnabled.checked,
    orbSkin: orbSkin.value,
    autoHideSeconds: Number(autoHide.value) || 0,
    wakeShortcut: wakeShortcut.value.trim(),
    language: language.value,
  }
}

// ── 皮肤 ────────────────────────────────────────────────────────────────
async function loadSkins(): Promise<void> {
  try {
    const current = orbSkin.value
    const skins = (await window.desktop.listSkins()) as Array<{ id: string; displayName: string }>
    orbSkin.innerHTML = '<option value="">默认流光球</option>'
    for (const skin of skins) {
      const option = document.createElement('option')
      option.value = skin.id
      option.textContent = skin.displayName || skin.id
      orbSkin.appendChild(option)
    }
    orbSkin.value = current
  } catch (error) {
    console.error('皮肤列表加载失败：', error)
  }
}

refreshSkinsBtn.addEventListener('click', () => void loadSkins())

// ── 声纹 ────────────────────────────────────────────────────────────────
async function refreshVoiceprintStatus(): Promise<void> {
  try {
    const status = (await window.desktop.voiceprintStatus()) as { enrolled: boolean }
    if (status.enrolled) {
      voiceprintStatusEl.textContent = '已注册'
      voiceprintVerifyBtn.disabled = false
    } else {
      voiceprintStatusEl.textContent = '未注册'
      voiceprintVerifyBtn.disabled = true
    }
  } catch {
    voiceprintStatusEl.textContent = '状态未知'
  }
}

async function runVoiceprint(kind: 'enroll' | 'verify'): Promise<void> {
  voiceprintEnrollBtn.disabled = true
  voiceprintVerifyBtn.disabled = true
  voiceprintLog.textContent = ''
  voiceprintLog.classList.remove('hidden')
  try {
    const result = kind === 'enroll'
      ? await window.desktop.voiceprintEnroll()
      : await window.desktop.voiceprintVerify()
    const r = result as { ok: boolean }
    if (r.ok) void refreshVoiceprintStatus()
  } catch (error) {
    voiceprintLog.textContent += `\n错误：${String(error)}\n`
  } finally {
    voiceprintEnrollBtn.disabled = false
    voiceprintVerifyBtn.disabled = false
  }
}

window.desktop.onVoiceprintProgress((text) => {
  voiceprintLog.textContent += text
  voiceprintLog.scrollTop = voiceprintLog.scrollHeight
})

voiceprintEnrollBtn.addEventListener('click', () => void runVoiceprint('enroll'))
voiceprintVerifyBtn.addEventListener('click', () => void runVoiceprint('verify'))

// ── 运行状态 ────────────────────────────────────────────────────────────
const VOICE_STATUS_LABEL: Record<string, string> = {
  starting: '启动中（加载模型…）',
  running: '运行中',
  stopped: '未启用',
  error: '启动失败',
}

function setVoiceStatusLabel(status: string): void {
  const voiceEl = document.getElementById('current-voice')!
  voiceEl.textContent = VOICE_STATUS_LABEL[status] ?? status
  if (status === 'running') voiceEl.className = 'connection-status ok'
  else if (status === 'starting') voiceEl.className = 'connection-status checking'
  else if (status === 'error') voiceEl.className = 'connection-status error'
  else voiceEl.className = ''
}

window.desktop.onVoiceStatusChange((status) => {
  setVoiceStatusLabel(status)
})

window.desktop.onVoiceLog((line) => {
  voiceLog.classList.remove('hidden')
  voiceLog.textContent += line + '\n'
  // 只保留最近 200 行
  const lines = voiceLog.textContent.split('\n')
  if (lines.length > 200) {
    voiceLog.textContent = lines.slice(-200).join('\n')
  }
  voiceLog.scrollTop = voiceLog.scrollHeight
})

async function refreshRuntimeStatus(): Promise<void> {
  // Gateway
  const gatewayEl = document.getElementById('current-gateway')!
  try {
    const url = await window.desktop.getGatewayUrl()
    if (url) {
      gatewayEl.textContent = `已连接 ${url}`
      gatewayEl.className = 'connection-status ok'
    } else {
      gatewayEl.textContent = '未启动'
      gatewayEl.className = 'connection-status error'
    }
  } catch {
    gatewayEl.textContent = '未知'
    gatewayEl.className = 'connection-status error'
  }
  // 语音引擎
  const voiceEl = document.getElementById('current-voice')!
  try {
    const status = (await window.desktop.voiceStatus()) as { running: boolean }
    setVoiceStatusLabel(status.running ? 'running' : 'stopped')
  } catch {
    setVoiceStatusLabel('stopped')
  }
  // 后台 Agent
  const backendEl = document.getElementById('current-backend')!
  backendEl.textContent = agentKind.value === 'codex' ? 'Codex' : 'pi'
  backendEl.className = 'connection-status ok'
}

// ── 表单提交 ─────────────────────────────────────────────────────────────
async function load(): Promise<void> {
  const settings = (await window.desktop.getSettings()) as unknown as SettingsPayload
  render(settings)
  void refreshRuntimeStatus()
}

document.getElementById('settings-form')!.addEventListener('submit', async (event) => {
  event.preventDefault()
  applyButton.disabled = true
  try {
    const saved = (await window.desktop.saveSettings(
      collect() as unknown as Record<string, unknown>,
    )) as unknown as SettingsPayload
    render(saved)
    messageEl.textContent = '已应用'
    setTimeout(() => { messageEl.textContent = '' }, 2000)
    void refreshRuntimeStatus()
  } catch (error) {
    messageEl.textContent = `应用失败：${String(error)}`
  } finally {
    applyButton.disabled = false
  }
})

// ── 启动 ────────────────────────────────────────────────────────────────
void load()
void loadSkins()
void refreshVoiceprintStatus()
