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
  /** 唤醒/显示悬浮球的全局快捷键（空 = 禁用） */
  wakeShortcut: string
  /** 空闲多少秒后自动隐藏悬浮球（0 = 禁用） */
  autoHideSeconds: number
  /** 是否启用声纹验证（需先注册声纹） */
  enableVoiceprint: boolean
  /** 语音引擎 LLM 后端 */
  llmBackend: string
  /** LLM API Key（responses-api 用） */
  llmApiKey: string
  /** LLM API 地址（远程后端用，对应 --responses_api_base_url） */
  llmBaseUrl: string
  /** LLM 模型名（空 = 后端默认） */
  llmModel: string
  /** STT 后端 */
  sttBackend: string
  /** STT 模型名（空 = 后端默认） */
  sttModel: string
  /** TTS 后端 */
  ttsBackend: string
  /** TTS 音色（空 = 后端默认） */
  ttsVoice: string
  /** 界面语言 */
  language: string
  /** LLM 推理等级：none（关闭思考）/ low / medium / high（对应 --responses_api_reasoning_effort） */
  llmReasoningEffort: 'none' | 'low' | 'medium' | 'high'
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  agentKind: 'pi',
  gatewayPort: 3101,
  enableVoice: false,
  wakeWordEnabled: false,
  wakeWord: '噜噜噜噜',
  orbSkin: '',
  wakeShortcut: 'CommandOrControl+Shift+O',
  autoHideSeconds: 0,
  enableVoiceprint: false,
  llmBackend: 'responses-api',
  llmApiKey: '',
  llmBaseUrl: '',
  llmModel: '',
  sttBackend: 'parakeet-tdt',
  sttModel: '',
  ttsBackend: 'qwen3',
  ttsVoice: '',
  language: 'auto',
  llmReasoningEffort: 'none',
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
    if (typeof raw.wakeShortcut === 'string') {
      out.wakeShortcut = raw.wakeShortcut.trim()
    }
    if (typeof raw.autoHideSeconds === 'number' && raw.autoHideSeconds >= 0) {
      out.autoHideSeconds = Math.floor(raw.autoHideSeconds)
    }
    if (typeof raw.enableVoiceprint === 'boolean') out.enableVoiceprint = raw.enableVoiceprint
    if (typeof raw.llmBackend === 'string' && raw.llmBackend.trim()) out.llmBackend = raw.llmBackend.trim()
    if (typeof raw.llmApiKey === 'string') out.llmApiKey = raw.llmApiKey
    if (typeof raw.llmBaseUrl === 'string') out.llmBaseUrl = raw.llmBaseUrl.trim()
    if (typeof raw.llmModel === 'string') out.llmModel = raw.llmModel.trim()
    if (typeof raw.language === 'string' && raw.language.trim()) out.language = raw.language.trim()
    if (typeof raw.sttBackend === 'string' && raw.sttBackend.trim()) out.sttBackend = raw.sttBackend.trim()
    if (typeof raw.sttModel === 'string') out.sttModel = raw.sttModel.trim()
    if (typeof raw.ttsBackend === 'string' && raw.ttsBackend.trim()) out.ttsBackend = raw.ttsBackend.trim()
    if (typeof raw.ttsVoice === 'string') out.ttsVoice = raw.ttsVoice.trim()
    if (typeof raw.llmReasoningEffort === 'string' && ['none', 'low', 'medium', 'high'].includes(raw.llmReasoningEffort)) {
      out.llmReasoningEffort = raw.llmReasoningEffort as DesktopSettings['llmReasoningEffort']
    } else if (typeof raw.llmDisableThinking === 'boolean') {
      // 旧版布尔开关迁移：true（禁用思考）→ none；false（开启思考）→ medium
      out.llmReasoningEffort = raw.llmDisableThinking ? 'none' : 'medium'
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
