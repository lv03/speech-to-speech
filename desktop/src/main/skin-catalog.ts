import { homedir } from 'node:os'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, basename } from 'node:path'

// 与 Codex App / qwen-audio-agent 对齐的 pet 包常量
const MAX_SPRITESHEET_BYTES = 8 * 1024 * 1024
const MAX_PET_FRAMES = 256
const DEFAULT_FRAME = { width: 192, height: 208, columns: 8, rows: 9 }
const V2_DEFAULT_ROWS = 11
const SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export interface FrameSpec {
  width: number
  height: number
  columns: number
  rows: number
}

export interface SkinInfo {
  id: string
  displayName: string
  spritesheetPath: string
  frame: FrameSpec
  spriteVersionNumber: number
  /** 磁盘上皮肤目录的绝对路径 */
  directory: string
}

/** 皮肤目录候选：兼容 Codex App 的 ~/.codex/pets/，以及我们自己的 skins 目录。 */
export function skinDirectories(ownSkinsDir: string): string[] {
  const dirs = [join(homedir(), '.codex', 'pets'), ownSkinsDir]
  return dirs.filter((d) => d)
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

/** 最小 WebP 头解析，覆盖 VP8X / VP8 / VP8L。 */
function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (
    buffer.length < 30
    || buffer.toString('latin1', 0, 4) !== 'RIFF'
    || buffer.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return null
  }
  const chunk = buffer.toString('latin1', 12, 16)
  if (chunk === 'VP8X') {
    return { width: 1 + readUInt24LE(buffer, 24), height: 1 + readUInt24LE(buffer, 27) }
  }
  if (chunk === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) return null
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

function frameSpec(manifest: Record<string, unknown>): FrameSpec {
  const version = manifest.spriteVersionNumber ?? 1
  const fallbackRows = version === 2 ? V2_DEFAULT_ROWS : DEFAULT_FRAME.rows
  const spec = (manifest.frame && typeof manifest.frame === 'object'
    ? manifest.frame
    : { ...DEFAULT_FRAME, rows: fallbackRows }) as Record<string, unknown>
  for (const key of ['width', 'height', 'columns', 'rows']) {
    if (!positiveInteger(spec[key])) {
      throw new Error(`皮肤包 frame.${key} 必须是正整数`)
    }
  }
  return {
    width: spec.width as number,
    height: spec.height as number,
    columns: spec.columns as number,
    rows: spec.rows as number,
  }
}

/** 校验一个 pet 包目录，返回皮肤信息；不合法则抛错。 */
export function validateSkinPackage(dir: string): SkinInfo {
  const manifestPath = join(dir, 'pet.json')
  if (!existsSync(manifestPath)) throw new Error('皮肤包缺少 pet.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new Error('皮肤包 pet.json 不是有效的 JSON')
  }
  const id = String(manifest.id || '').trim()
  if (!SKIN_ID_PATTERN.test(id)) throw new Error('皮肤包 pet.json 缺少合法的 id')

  const spritesheetRelative = String(manifest.spritesheetPath || 'spritesheet.webp').trim()
  const spritesheetPath = resolve(dir, spritesheetRelative)
  const pathFromDir = relative(resolve(dir), spritesheetPath)
  if (pathFromDir.startsWith('..') || pathFromDir.includes('\0')) {
    throw new Error('皮肤包 spritesheetPath 不能指向包目录之外')
  }
  if (!existsSync(spritesheetPath) || !statSync(spritesheetPath).isFile()) {
    throw new Error(`皮肤包缺少贴图文件 ${spritesheetRelative}`)
  }
  if (statSync(spritesheetPath).size > MAX_SPRITESHEET_BYTES) {
    throw new Error('皮肤包贴图超过 8MB 上限')
  }
  const frame = frameSpec(manifest)
  const frameCount = frame.columns * frame.rows
  if (frameCount > MAX_PET_FRAMES) throw new Error(`皮肤包总帧数不能超过 ${MAX_PET_FRAMES}`)

  const dimensions = webpDimensions(readFileSync(spritesheetPath))
  if (!dimensions) throw new Error('皮肤包贴图不是有效的 WebP 文件')
  const expectedWidth = frame.columns * frame.width
  const expectedHeight = frame.rows * frame.height
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    throw new Error(
      `皮肤包贴图尺寸应为 ${expectedWidth}x${expectedHeight}，实际是 ${dimensions.width}x${dimensions.height}`,
    )
  }
  return {
    id,
    displayName: String(manifest.displayName || id).trim() || id,
    spritesheetPath: spritesheetRelative,
    frame,
    spriteVersionNumber: Number(manifest.spriteVersionNumber ?? 1),
    directory: resolve(dir),
  }
}

/** 扫描多个皮肤目录，返回所有合法皮肤（坏包跳过）。 */
export function listSkins(dirs: string[]): SkinInfo[] {
  const seen = new Set<string>()
  const skins: SkinInfo[] = []
  for (const dir of dirs) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const packageDir = join(dir, entry.name)
      try {
        const info = validateSkinPackage(packageDir)
        if (info.id !== entry.name) continue
        if (seen.has(info.id)) continue
        seen.add(info.id)
        skins.push(info)
      } catch {
        // 坏包跳过
      }
    }
  }
  return skins.sort((a, b) => a.id.localeCompare(b.id))
}

/** 定位某个皮肤的贴图文件绝对路径。 */
export function skinSpritesheetPath(skin: SkinInfo): string {
  const p = resolve(skin.directory, skin.spritesheetPath)
  return basename(p) === skin.spritesheetPath ? p : join(skin.directory, skin.spritesheetPath)
}
