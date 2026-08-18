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
}

const agentKind = document.getElementById('agent-kind') as HTMLSelectElement
const gatewayPort = document.getElementById('gateway-port') as HTMLInputElement
const enableVoice = document.getElementById('enable-voice') as HTMLInputElement
const wakeWordEnabled = document.getElementById('wake-word-enabled') as HTMLInputElement
const wakeWord = document.getElementById('wake-word') as HTMLInputElement
const voiceprintEnabled = document.getElementById('voiceprint-enabled') as HTMLInputElement
const orbSkin = document.getElementById('orb-skin') as HTMLSelectElement
const wakeShortcut = document.getElementById('wake-shortcut') as HTMLInputElement
const autoHide = document.getElementById('auto-hide') as HTMLInputElement
const voiceprintStatusEl = document.getElementById('voiceprint-status')!
const voiceprintEnrollBtn = document.getElementById('voiceprint-enroll') as HTMLButtonElement
const voiceprintVerifyBtn = document.getElementById('voiceprint-verify') as HTMLButtonElement
const voiceprintLog = document.getElementById('voiceprint-log')!
const saveButton = document.getElementById('save') as HTMLButtonElement
const saveStatus = document.getElementById('save-status')!

function render(settings: SettingsPayload): void {
  agentKind.value = settings.agentKind
  gatewayPort.value = String(settings.gatewayPort)
  enableVoice.checked = settings.enableVoice
  wakeWordEnabled.checked = settings.wakeWordEnabled
  wakeWord.value = settings.wakeWord
  voiceprintEnabled.checked = settings.enableVoiceprint
  orbSkin.value = settings.orbSkin
  wakeShortcut.value = settings.wakeShortcut
  autoHide.value = String(settings.autoHideSeconds ?? 0)
}

function collect(): SettingsPayload {
  return {
    agentKind: agentKind.value === 'codex' ? 'codex' : 'pi',
    gatewayPort: Number(gatewayPort.value) || 3101,
    enableVoice: enableVoice.checked,
    wakeWordEnabled: wakeWordEnabled.checked,
    wakeWord: wakeWord.value.trim() || '噜噜噜噜',
    orbSkin: orbSkin.value,
    wakeShortcut: wakeShortcut.value.trim(),
    autoHideSeconds: Math.max(0, Number(autoHide.value) || 0),
    enableVoiceprint: voiceprintEnabled.checked,
  }
}

async function loadSkins(): Promise<void> {
  try {
    const skins = (await window.desktop.listSkins()) as Array<{ id: string; displayName: string }>
    for (const skin of skins) {
      const option = document.createElement('option')
      option.value = skin.id
      option.textContent = skin.displayName || skin.id
      orbSkin.appendChild(option)
    }
  } catch (error) {
    console.error('皮肤列表加载失败：', error)
  }
}

async function load(): Promise<void> {
  const settings = (await window.desktop.getSettings()) as unknown as SettingsPayload
  render(settings)
}

saveButton.addEventListener('click', async () => {
  try {
    const saved = (await window.desktop.saveSettings(
      collect() as unknown as Record<string, unknown>,
    )) as unknown as SettingsPayload
    render(saved)
    saveStatus.textContent = '已保存'
    saveStatus.className = 'ok'
    setTimeout(() => { saveStatus.textContent = '' }, 2000)
  } catch (error) {
    saveStatus.textContent = `保存失败：${String(error)}`
    saveStatus.className = 'err'
  }
})

async function refreshVoiceprintStatus(): Promise<void> {
  try {
    const status = (await window.desktop.voiceprintStatus()) as { enrolled: boolean; path: string }
    if (status.enrolled) {
      voiceprintStatusEl.textContent = '已注册'
      voiceprintStatusEl.className = 'voiceprint-status enrolled'
      voiceprintVerifyBtn.disabled = false
    } else {
      voiceprintStatusEl.textContent = '未注册'
      voiceprintStatusEl.className = 'voiceprint-status'
      voiceprintVerifyBtn.disabled = true
    }
  } catch {
    voiceprintStatusEl.textContent = '状态未知'
    voiceprintStatusEl.className = 'voiceprint-status'
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

void load()
void loadSkins()
void refreshVoiceprintStatus()
