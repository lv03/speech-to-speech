import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface DesktopSettings {
  /** 后端 coding agent 类型 */
  agentKind: 'pi' | 'codex'
  /** Gateway 端口 */
  gatewayPort: number
  /** 是否内嵌启动语音引擎（speech-to-speech local） */
  enableVoice: boolean
  /** 唤醒词开关 */
  wakeWordEnabled: boolean
  /** 唤醒词文本 */
  wakeWord: string
  /** 悬浮球皮肤（空 = 默认流光球；否则为 pet 包 id） */
  orbSkin: string
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  agentKind: 'pi',
  gatewayPort: 3101,
  enableVoice: false,
  wakeWordEnabled: false,
  wakeWord: '噜噜噜噜',
  orbSkin: '',
}

export class SettingsStore {
  private readonly path: string
  private cache: DesktopSettings

  constructor(directory?: string) {
    const dir = directory || join(app.getPath('userData'), 'settings.json')
    this.path = dir
    this.cache = this.load()
  }

  get(): DesktopSettings {
    return { ...this.cache }
  }

  private load(): DesktopSettings {
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, 'utf-8'))
        return { ...DEFAULT_SETTINGS, ...this.sanitize(raw) }
      }
    } catch {
      // 配置损坏时回退默认值
    }
    return { ...DEFAULT_SETTINGS }
  }

  private sanitize(raw: Record<string, unknown>): Partial<DesktopSettings> {
    const out: Partial<DesktopSettings> = {}
    if (raw.agentKind === 'pi' || raw.agentKind === 'codex') {
      out.agentKind = raw.agentKind
    }
    if (typeof raw.gatewayPort === 'number' && raw.gatewayPort > 0 && raw.gatewayPort < 65536) {
      out.gatewayPort = Math.floor(raw.gatewayPort)
    }
    if (typeof raw.enableVoice === 'boolean') out.enableVoice = raw.enableVoice
    if (typeof raw.wakeWordEnabled === 'boolean') out.wakeWordEnabled = raw.wakeWordEnabled
    if (typeof raw.wakeWord === 'string' && raw.wakeWord.trim()) {
      out.wakeWord = raw.wakeWord.trim()
    }
    if (typeof raw.orbSkin === 'string') {
      out.orbSkin = raw.orbSkin.trim()
    }
    return out
  }

  save(next: Partial<DesktopSettings>): DesktopSettings {
    this.cache = { ...this.cache, ...this.sanitize(next) }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.cache, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      })
    } catch (error) {
      console.error('[desktop] 设置写入失败：', error)
    }
    return this.get()
  }
}
