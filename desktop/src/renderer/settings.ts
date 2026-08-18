interface SettingsPayload {
  agentKind: 'pi' | 'codex'
  gatewayPort: number
  enableVoice: boolean
  wakeWordEnabled: boolean
  wakeWord: string
  orbSkin: string
}

const agentKind = document.getElementById('agent-kind') as HTMLSelectElement
const gatewayPort = document.getElementById('gateway-port') as HTMLInputElement
const enableVoice = document.getElementById('enable-voice') as HTMLInputElement
const wakeWordEnabled = document.getElementById('wake-word-enabled') as HTMLInputElement
const wakeWord = document.getElementById('wake-word') as HTMLInputElement
const orbSkin = document.getElementById('orb-skin') as HTMLSelectElement
const saveButton = document.getElementById('save') as HTMLButtonElement
const saveStatus = document.getElementById('save-status')!

function render(settings: SettingsPayload): void {
  agentKind.value = settings.agentKind
  gatewayPort.value = String(settings.gatewayPort)
  enableVoice.checked = settings.enableVoice
  wakeWordEnabled.checked = settings.wakeWordEnabled
  wakeWord.value = settings.wakeWord
  orbSkin.value = settings.orbSkin
}

function collect(): SettingsPayload {
  return {
    agentKind: agentKind.value === 'codex' ? 'codex' : 'pi',
    gatewayPort: Number(gatewayPort.value) || 3101,
    enableVoice: enableVoice.checked,
    wakeWordEnabled: wakeWordEnabled.checked,
    wakeWord: wakeWord.value.trim() || '噜噜噜噜',
    orbSkin: orbSkin.value,
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

void load()
void loadSkins()
